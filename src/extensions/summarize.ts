import { Chunk, Effect, Layer, Ref, Stream } from "effect";
import { AgentCtx } from "../core/agent-ctx";
import type { Extension } from "../core/agent";
import { findSafeCompactionToSeq, lastCompactionEnd } from "../core/compaction";
import type { Fragment, Event, ProviderContext } from "../core/types";
import { eventToFragment } from "../core/projections";
import { estimateTokensFromContext } from "./tokens";

export interface SummarizeOptions {
  // Fire when estimated tokens exceed this. Checked against the current
  // projection, so other compaction transforms (snip, truncate) count.
  maxTokens?: number;
  // Alternative trigger: fire when conversation events accumulated since
  // the last boundary exceed this. Ignored when maxTokens is set.
  maxEvents?: number;
  // Keep this many most-recent events uncompacted after each firing.
  tail: number;
  // Produce a prose summary of the slice being compacted. Kept outside
  // the extension so the package stays runtime-agnostic — the caller
  // wires this up with whatever LLM they have access to.
  summarize: (oldBlocks: Fragment[]) => Promise<string>;
  // Rough token estimator over the final ProviderContext. Defaults to
  // ~4 chars per token. Receives the post-adapter context — the same
  // shape `infer` will see — so token budgets reflect what the
  // provider actually receives.
  estimateTokens?: (context: ProviderContext) => number;
  // Circuit breaker. Stops trying after this many consecutive failures
  // (empty response or thrown error). Default 3.
  maxFailures?: number;
}

// Threshold-driven compaction. Each firing appends one
// `compaction.summary` event; the projection collapses the covered
// range at render time. Runs entirely inside the managed runtime (the
// watcher is a forked fiber), so it writes to the log via direct
// `yield*` — no cross-runtime bridge needed.
export const summarize = (opts: SummarizeOptions): Extension => {
  const {
    maxTokens,
    maxEvents,
    tail,
    summarize: summarizeFn,
    estimateTokens = estimateTokensFromContext,
    maxFailures = 3,
  } = opts;

  if (maxTokens === undefined && maxEvents === undefined) {
    throw new Error("summarize() requires either maxTokens or maxEvents");
  }
  if (maxTokens !== undefined && maxEvents !== undefined) {
    throw new Error(
      "summarize() accepts only one trigger — pass maxTokens or maxEvents, not both",
    );
  }

  return Layer.scopedDiscard(
    Effect.gen(function* () {
      const ctx = yield* AgentCtx;
      const failuresRef = yield* Ref.make(0);
      const inFlightRef = yield* Ref.make(false);

      const recordFailure = (err: unknown): Effect.Effect<void> =>
        Effect.gen(function* () {
          const error = err instanceof Error ? err : new Error(String(err));
          yield* ctx.reportError("compaction-summarize", error);
          logCompactionError("compaction-summarize", error);
          const next = yield* Ref.updateAndGet(failuresRef, (n) => n + 1);
          if (next === maxFailures) {
            const disabled = new Error(
              `summarization disabled after ${next} consecutive failures`,
            );
            yield* ctx.reportError("compaction-disabled", disabled);
            logCompactionError("compaction-disabled", disabled);
          }
        });

      const step = Effect.gen(function* () {
        const inFlight = yield* Ref.get(inFlightRef);
        if (inFlight) return;
        const failures = yield* Ref.get(failuresRef);
        if (failures >= maxFailures) return;

        const events = yield* ctx.events.snapshot;
        const size = Chunk.size(events);
        const lastEnd = lastCompactionEnd(events);
        const fromSeq = lastEnd + 1;
        const ceiling = size - 1 - tail;
        if (ceiling < fromSeq) return;
        // Retreat toSeq past any tool-call group that straddles the
        // split — same reason as auto-compact. A broken split would
        // orphan tool.result blocks in the tail and break inference.
        const safe = findSafeCompactionToSeq(events, fromSeq, ceiling);
        if (safe.kind === "none") return;
        const toSeq = safe.toSeq;

        const arr = Chunk.toReadonlyArray(events);
        const newConvCount = countConversation(arr, fromSeq, toSeq);
        if (newConvCount === 0) return;

        const context = yield* ctx.render;
        const shouldFire =
          maxTokens !== undefined
            ? estimateTokens(context) > maxTokens
            : newConvCount > (maxEvents ?? Infinity);
        if (!shouldFire) return;

        const slice: Fragment[] = [];
        for (const e of arr) {
          if (e.seq < fromSeq || e.seq > toSeq) continue;
          const b = eventToFragment(e);
          if (b) slice.push(b);
        }
        if (slice.length === 0) return;

        yield* Ref.set(inFlightRef, true);
        const result = yield* Effect.tryPromise({
          try: () => summarizeFn(slice),
          catch: (e) => e,
        }).pipe(Effect.either);
        yield* Ref.set(inFlightRef, false);

        if (result._tag === "Left") {
          yield* recordFailure(result.left);
          return;
        }
        const text = result.right;
        if (!text) {
          yield* recordFailure(new Error("summarize() returned empty text"));
          return;
        }
        yield* Ref.set(failuresRef, 0);
        yield* ctx.events.append({
          type: "compaction.summary",
          fromSeq,
          toSeq,
          text,
        });
      });

      const driver = ctx.rendered.changes.pipe(
        Stream.mapEffect(() => step, { concurrency: 1 }),
      );
      yield* Effect.forkScoped(Stream.runDrain(driver));
    }),
  );
};

const countConversation = (
  arr: readonly Event[],
  fromSeq: number,
  toSeq: number,
): number => {
  let n = 0;
  for (const e of arr) {
    if (e.seq < fromSeq || e.seq > toSeq) continue;
    if (
      e.type === "user.message" ||
      e.type === "assistant.message" ||
      e.type === "tool.result"
    ) {
      n++;
    }
  }
  return n;
};

function logCompactionError(phase: string, err: Error): void {
  const g = globalThis as { console?: { error?: (...args: unknown[]) => void } };
  g.console?.error?.(`[compaction] ${phase}:`, err);
}

export const SUMMARIZATION_PROMPT = `You are summarizing a conversation between a user and an AI agent so the agent can continue working without losing context.

Respond with TEXT ONLY. Do NOT call any tools.

Produce a concise summary with these sections, each on its own line:

1. User's primary request — the overarching goal.
2. Key technical concepts — terms, libraries, patterns discussed.
3. Files & code — what was read, written, or changed.
4. Errors & resolutions — problems hit and how they were handled.
5. Approach — the agent's reasoning and strategy so far.
6. Recent user intent — the latest direction or correction.
7. Pending tasks — what remains unfinished.
8. Current work — what was being worked on immediately before this summary.
9. Optional next step — a natural continuation if there is one.

Preserve enough detail that the work can resume without re-discovering prior context, but keep the summary tight.`;
