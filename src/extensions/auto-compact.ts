import { Chunk, Effect, Layer } from "effect";
import { AgentCtx } from "../agent-ctx";
import type { Extension } from "../agent";
import { findSafeCompactionToSeq, lastCompactionEnd } from "../compaction";
import { eventToFragment } from "../projections";
import type { Fragment, ToolOutcome } from "../types";
import { addToolReporting } from "./tool-registration";

export interface CompactOptions {
  // Produce a prose summary of the slice being compacted.
  readonly summarize: (oldBlocks: Fragment[]) => Promise<string>;
  // Events from the tail stay uncompacted. Default 10.
  readonly tail?: number;
  // Override the tool name. Default "compact".
  readonly toolName?: string;
  // Override the tool description surfaced to the model.
  readonly description?: string;
}

// Registers a tool the main model can call to compact conversation
// history itself. The tool body is a pure function — computes the
// range, calls the summarizer, returns a `ToolOutcome` that DECLARES a
// `compaction.summary` event for the framework to append alongside
// the normal `tool.result`. No cross-runtime writes: the tool never
// touches reactive state, the framework (tool-exec) does the append
// in the managed runtime as a single atomic batch.
//
// Shares `compaction.summary` semantics with `summarize()` — both ride
// the same event type, the same projection behavior. Stacking works
// naturally: each call appends one boundary event; the projection
// collapses all covered ranges.
export const compact = (opts: CompactOptions): Extension => {
  const tail = opts.tail ?? 10;
  const toolName = opts.toolName ?? "compact";
  const description =
    opts.description ??
    "Compact the conversation so far into a summary to free context budget. Pass an optional `prompt` describing what to emphasize or preserve in the summary.";

  return Layer.scopedDiscard(
    Effect.gen(function* () {
      const ctx = yield* AgentCtx;
      yield* addToolReporting(ctx, "auto-compact", {
        name: toolName,
        description,
        parameters: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description:
                "Optional focus — what to emphasize or preserve in the summary (e.g. 'keep the auth debugging details, drop the styling tangent').",
            },
          },
        },
        run: async (args): Promise<ToolOutcome> => {
          const prompt =
            typeof args.prompt === "string" && args.prompt.length > 0
              ? args.prompt
              : undefined;
          // Read-only snapshot is safe across runtimes. The write path
          // (the compaction.summary event) is declared via extraEvents
          // so tool-exec performs the append inside the managed
          // runtime, avoiding the cross-runtime hazard.
          const events = await Effect.runPromise(ctx.events.snapshot);
          const arr = Chunk.toReadonlyArray(events);
          const size = arr.length;
          const lastEnd = lastCompactionEnd(events);
          const fromSeq = lastEnd + 1;
          const ceiling = size - 1 - tail;
          if (ceiling < fromSeq) {
            return `Nothing to compact yet — fewer events than the tail threshold (tail=${tail}).`;
          }
          // Retreat toSeq so the split does not fall inside a
          // tool-call group. Splitting a group orphans tool.result
          // blocks in the tail — providers reject the payload.
          const safe = findSafeCompactionToSeq(events, fromSeq, ceiling);
          if (safe.kind === "none") {
            return safe.reason === "unresolved"
              ? "Nothing to compact yet — a tool call within the compactable window is still running."
              : `Nothing to compact yet — the next safe boundary lies beyond the tail threshold (tail=${tail}).`;
          }
          const toSeq = safe.toSeq;
          const slice: Fragment[] = [];
          for (const e of arr) {
            if (e.seq < fromSeq || e.seq > toSeq) continue;
            const b = eventToFragment(e);
            if (b) slice.push(b);
          }
          if (slice.length === 0) {
            return "Nothing to compact — the range had no history events.";
          }
          const input: Fragment[] = prompt
            ? [
                {
                  tag: "core/user-message",
                  source: "auto-compact:focus",
                  eventSeq: -1,
                  content: `Focus for this summary: ${prompt}`,
                },
                ...slice,
              ]
            : slice;
          let text: string;
          try {
            text = await opts.summarize(input);
          } catch (e) {
            return `Compaction failed: ${e instanceof Error ? e.message : String(e)}`;
          }
          if (!text) return "Compaction failed: summarizer returned empty text.";

          const covered = toSeq - fromSeq + 1;
          return {
            content: `Compacted ${covered} events (${fromSeq}..${toSeq}) into a summary. Prior history is preserved in the log — boundaries replay on hydration.`,
            extraEvents: [
              {
                type: "compaction.summary",
                fromSeq,
                toSeq,
                text,
                ...(prompt ? { prompt } : {}),
              },
            ],
          };
        },
      });
    }),
  );
};
