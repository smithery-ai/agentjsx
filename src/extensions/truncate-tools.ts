import { Effect, Layer } from "effect";
import { AgentCtx } from "../core/agent-ctx";
import type { Extension } from "../core/agent";
import type { Fragment } from "../core/types";

export interface TruncateToolsOptions {
  // Number of most-recent tool-result blocks to keep intact. Older ones
  // have their content replaced with the placeholder.
  keepRecent: number;
  // Placeholder text that replaces old tool-result content. The block
  // itself (role, tool_call_id) stays — only the body is cleared, so
  // the LLM still sees a valid tool_call / tool_result pairing.
  placeholder?: string;
}

// Clear the content of older tool-result blocks while keeping the
// structure intact. Inspired by Claude Code's microcompact — tool
// outputs are often the single largest token contributor in an agent
// conversation, and they're usually stale (the model already reasoned
// over them and acted). Clearing old ones preserves the conversation
// thread while reclaiming the bulk of the tokens.
//
// Non-destructive: the events log still carries the original content,
// the transform only changes the projection. Drop the extension and
// full tool outputs return.
export const truncateTools = (opts: TruncateToolsOptions): Extension => {
  const { keepRecent, placeholder = "[old tool result cleared]" } = opts;

  return Layer.scopedDiscard(
    Effect.gen(function* () {
      const ctx = yield* AgentCtx;
      yield* ctx.addTransform({
        name: "truncate-tools",
        run: (blocks) => {
          const toolIndices: number[] = [];
          blocks.forEach((b, i) => {
            if (b.tag === "core/tool-result" && b.source === "history") toolIndices.push(i);
          });
          if (toolIndices.length <= keepRecent) return blocks;

          const clearSet = new Set(
            toolIndices.slice(0, toolIndices.length - keepRecent),
          );
          return blocks.map((b, i): Fragment => {
            if (!clearSet.has(i)) return b;
            return { ...b, content: placeholder };
          });
        },
      });
    }),
  );
};
