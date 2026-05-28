import { Effect, Layer } from "effect";
import { AgentCtx } from "../core/agent-ctx";
import type { Extension } from "../core/agent";
import type { Fragment } from "../core/types";

export interface SnipOptions {
  // Keep the most recent N history blocks in the projection. Anything
  // older is hidden behind a marker.
  keep: number;
  // Marker text prepended when snipping occurs. Visible to the LLM so
  // it knows context was dropped (but not what was in it).
  marker?: (droppedCount: number) => string;
}

// Snip keeps the most recent N history blocks and hides older ones
// behind a system marker. Zero LLM cost — pure structural trim. Runs
// on every projection, so snipped content stays hidden across turns
// while the underlying events log is untouched.
//
// Modeled on Claude Code's snip layer: cheap, always-on, drops oldest
// complete rounds non-destructively. Pair with summarize() as a
// last-resort fallback — snip for most turns, summarize only when snip
// alone can't keep the context under budget.
export const snip = (opts: SnipOptions): Extension => {
  const { keep, marker = defaultMarker } = opts;

  return Layer.scopedDiscard(
    Effect.gen(function* () {
      const ctx = yield* AgentCtx;
      yield* ctx.addTransform({
        name: "snip",
        run: (blocks) => {
        const history: Fragment[] = [];
        const nonHistory: Fragment[] = [];
        for (const b of blocks) {
          if (b.source === "history") history.push(b);
          else nonHistory.push(b);
        }
        if (history.length <= keep) return blocks;

        // Pair-aware slicing. If the raw `keep` boundary would leave a
        // `tool` block at the head of the kept slice, its parent
        // assistant.message (which carries `tool_calls` referencing this
        // result) was snipped away and OpenAI rejects the projection:
        //   "messages with role 'tool' must be a response to a preceding
        //    message with 'tool_calls'."
        // Drop any leading orphan tool blocks from the slice. The LLM
        // loses visibility into that specific tool round-trip but the
        // projection stays valid. An alternative is to expand upward to
        // pick up the parent — that preserves more context at the cost
        // of occasionally exceeding `keep` by 1. We pick strict drop-
        // leading-orphans here because `keep` is a budget knob; operators
        // who want parent-inclusion can compose snip with a tool-aware
        // summarizer.
        let slice = history.slice(-keep);
        while (slice.length > 0 && slice[0].tag === "core/tool-result") {
          slice = slice.slice(1);
        }
        // Compute dropped count AFTER the orphan trim so the marker
        // reflects what's actually omitted from the projection.
        const dropped = history.length - slice.length;
        const boundary: Fragment = {
          tag: "core/system",
          content: marker(dropped),
          source: "snip",
        };
        return [...nonHistory, boundary, ...slice];
        },
      });
    }),
  );
};

function defaultMarker(droppedCount: number): string {
  return `[${droppedCount} earlier conversation turn${droppedCount === 1 ? "" : "s"} omitted]`;
}
