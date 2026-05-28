import { Chunk, Effect, type Fiber, type Scope, Stream, SubscriptionRef } from "effect";
import { AgentCtx } from "./agent-ctx";
import { ToolExecutionError } from "./errors";
import type { EventInput } from "./event-log";
import { PendingSends } from "./pending-sends";
import { isHalted, pendingToolCallsFromLog } from "./projections";
import type { Event, Tool, ToolCall, ToolOutcome } from "./types";

// Stable set-of-ids key for changesWith dedupe. Two batches compare
// equal iff they cover the same tool_call ids.
const callIdsKey = (calls: ReadonlyArray<ToolCall>): string =>
  calls.map((c) => c.id).sort().join("|");

export interface RunToolExecutionOptions {
  // Maximum number of tools that run concurrently within a single tool
  // batch. Pass `"unbounded"` to opt out of the cap. The model can issue
  // many simultaneous calls; without a cap, rate-limited backends, the
  // filesystem, or subprocess-spawning tools can stampede.
  readonly concurrency: number | "unbounded";
}

interface RawResult {
  readonly tool_call_id: string;
  readonly content: string;
  readonly extraEvents?: ReadonlyArray<EventInput>;
}

// Normalize a tool's return value into a RawResult. Plain string is the
// common case; the richer form lets a tool declare structural events
// the framework appends alongside its `tool.result`.
const normalizeOutcome = (
  call: ToolCall,
  outcome: ToolOutcome,
): RawResult =>
  typeof outcome === "string"
    ? { tool_call_id: call.id, content: outcome }
    : {
        tool_call_id: call.id,
        content: outcome.content,
        ...(outcome.extraEvents ? { extraEvents: outcome.extraEvents } : {}),
      };

// Tool-execution loop. Fires whenever the log produces a new non-empty
// pending tool-call batch (deduplicated so repeated observations of the
// same batch don't re-run it). For each batch:
//
//   1. If halted at entry, skip entirely. No new tool batches after halt.
//   2. Append `tool.call.started` intent beacons BEFORE running tools.
//      Ordering is critical: a mid-run crash must leave a beacon the
//      hydration reconciler can pair with a synthetic interrupted
//      result. See signals/graph.ts:352-368.
//   3. Run all calls concurrently via Effect.forEach unbounded. Errors
//      (unknown tool, bad JSON, tool-run rejection) surface as string
//      content rows — the LLM sees the failure, not the runtime.
//   4. Append tool results UNCONDITIONALLY on halt-or-not. Side effects
//      already ran; the log must reflect them or hydration will lie.
//      See signals/graph.ts:392-399. Halt still prevents further
//      inference — the inference loop checks halt on entry.
//   5. Drain pending-sends buffer AFTER results land, UNLESS halted.
export const runToolExecution = (
  opts: RunToolExecutionOptions,
): Effect.Effect<
  Fiber.RuntimeFiber<void, never>,
  never,
  AgentCtx | PendingSends | Scope.Scope
> =>
  Effect.gen(function* () {
    const ctx = yield* AgentCtx;
    const pending = yield* PendingSends;

    const runOne = (call: ToolCall, tools: Chunk.Chunk<Tool>): Effect.Effect<RawResult> =>
      Effect.gen(function* () {
        const match = Chunk.findFirst(tools, (t) => t.name === call.function.name);
        if (match._tag === "None") {
          return {
            tool_call_id: call.id,
            content: `Error: Unknown tool "${call.function.name}"`,
          };
        }
        const tool = match.value;

        // JSON parse is synchronous and may throw; wrap in try so we
        // surface a string error to the LLM rather than tearing the
        // batch. Match the signals behavior: "Error: <message>".
        let args: Record<string, unknown>;
        try {
          const parsed: Record<string, unknown> = JSON.parse(call.function.arguments);
          args = parsed;
        } catch (e) {
          return {
            tool_call_id: call.id,
            content: `Error: ${e instanceof Error ? e.message : String(e)}`,
          };
        }

        // Tools may throw for two reasons: expected operational failures
        // (file not found, backend 500, bad arg that slipped past the
        // schema) and programming bugs (TypeError, ReferenceError). The
        // LLM gets the same string envelope either way so it can retry,
        // but we also report the full error to ctx.errors so operators
        // / dev tooling see the stack. This is the single catch site
        // for tool runs — individual extensions should not wrap their
        // `run` bodies in try/catch that re-swallow errors.
        const outcome = yield* Effect.tryPromise({
          try: () => tool.run(args, {}),
          catch: (cause) =>
            new ToolExecutionError({ toolName: tool.name, toolCallId: call.id, cause }),
        }).pipe(Effect.either);

        if (outcome._tag === "Left") {
          const err = outcome.left;
          yield* ctx.reportError(`tool:${tool.name}`, err);
          const cause = err.cause;
          const msg = cause instanceof Error ? cause.message : String(cause);
          return { tool_call_id: call.id, content: `Error: ${msg}` };
        }
        return normalizeOutcome(call, outcome.right);
      }).pipe(
        Effect.withSpan("agentctx.tool.run", {
          attributes: {
            "agentctx.tool.name": call.function.name,
            "agentctx.tool.call_id": call.id,
          },
        }),
      );

    const step = (calls: ReadonlyArray<ToolCall>): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (calls.length === 0) return;

        const beforeIntents = yield* ctx.events.snapshot;
        if (isHalted(beforeIntents)) return;

        // Intent beacons BEFORE tool.run. Append as a batch so seq
        // assignment is atomic — no interleaving reader can see a
        // partial intent set.
        const intents: ReadonlyArray<EventInput> = calls.map((call) => ({
          type: "tool.call.started" as const,
          tool_call_id: call.id,
          tool_name: call.function.name,
        }));
        yield* ctx.events.appendMany(intents);

        const tools = yield* SubscriptionRef.get(ctx.tools);
        const results = yield* Effect.forEach(calls, (c) => runOne(c, tools), {
          concurrency: opts.concurrency,
        });

        // Append results unconditionally — see invariant 5. Halt-check
        // only gates the pending-sends drain. Tools that declared
        // `extraEvents` get them appended BEFORE the `tool.result` in
        // the same atomic batch — keeps causal order (boundary event
        // before its announcement result) and a crash can't split them.
        const resultEvents: EventInput[] = [];
        for (const r of results) {
          if (r.extraEvents) resultEvents.push(...r.extraEvents);
          resultEvents.push({
            type: "tool.result" as const,
            tool_call_id: r.tool_call_id,
            content: r.content,
          });
        }
        yield* ctx.events.appendMany(resultEvents);

        const post = yield* ctx.events.snapshot;
        if (isHalted(post)) return;

        const drained = yield* pending.drainAll;
        if (drained.length === 0) return;
        const sendEvents: ReadonlyArray<EventInput> = drained.map((content) => ({
          type: "user.message" as const,
          content,
        }));
        yield* ctx.events.appendMany(sendEvents);
      }).pipe(
        Effect.withSpan("agentctx.tool.batch", {
          attributes: { "agentctx.tool.batch.size": calls.length },
        }),
        Effect.catchAllCause((cause) => ctx.reportError("tool_execution", cause)),
      );

    const driver: Stream.Stream<void> = ctx.events.changes.pipe(
      Stream.map((events: Chunk.Chunk<Event>) => pendingToolCallsFromLog(events)),
      Stream.filter((calls) => calls.length > 0),
      Stream.changesWith((a, b) => callIdsKey(a) === callIdsKey(b)),
      Stream.mapEffect(step, { concurrency: 1 }),
    );

    return yield* Effect.forkScoped(Stream.runDrain(driver));
  });
