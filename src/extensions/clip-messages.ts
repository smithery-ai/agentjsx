import { Effect, Layer } from "effect";
import { AgentCtx } from "../core/agent-ctx";
import type { Extension } from "../core/agent";
import type { Fragment } from "../core/types";

export interface ClipMessagesOptions {
  // Cap any single block's content at this many characters. Default
  // value is generous — this is a defensive layer against one outlier
  // blowing the budget, not a primary compaction strategy.
  maxChars: number;
  // Suffix appended to clipped content. Tells the LLM that truncation
  // happened and exposes how much was cut.
  suffix?: string;
  // When true (default), the most recent `user` block is left intact
  // regardless of length. That block is the pending request driving
  // the next inference; clipping it can silently truncate the actual
  // question when a long document precedes a short ask. Set to false
  // to restore the legacy "clip everything uniformly" behavior.
  preserveLastUser?: boolean;
}

// Per-message character cap. A defensive layer against single messages
// (usually tool results carrying huge outputs) blowing the token
// budget on their own. Applies uniformly to all blocks with ONE
// exception: the most recent `user` block is preserved verbatim.
// That block is the request the agent is about to act on — clipping
// it can truncate the actual question when the user pastes a long
// document with the real ask near the end. Operators who truly want
// to clip even the pending user turn can pass `preserveLastUser: false`.
//
// Cheap, deterministic, always-on. Runs before more expensive
// compaction strategies in the transform pipeline — anything clipped
// here reduces what the LLM summarizer has to process later.
export const clipMessages = (opts: ClipMessagesOptions): Extension => {
  const { maxChars, suffix = "\n[truncated]", preserveLastUser = true } = opts;

  return Layer.scopedDiscard(
    Effect.gen(function* () {
      const ctx = yield* AgentCtx;
      yield* ctx.addTransform({
        name: "clip-messages",
        run: (blocks) => {
          let lastUserIdx = -1;
          if (preserveLastUser) {
            for (let i = blocks.length - 1; i >= 0; i--) {
              if (blocks[i].tag === "core/user-message") {
                lastUserIdx = i;
                break;
              }
            }
          }
          return blocks.map((b, i): Fragment => {
            if (i === lastUserIdx) return b;
            if (b.content.length <= maxChars) return b;
            return { ...b, content: b.content.slice(0, maxChars) + suffix };
          });
        },
      });
    }),
  );
};
