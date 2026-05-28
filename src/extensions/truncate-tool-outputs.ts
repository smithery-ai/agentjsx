import { Effect, Layer } from "effect";
import { AgentCtx } from "../core/agent-ctx";
import type { Extension } from "../core/agent";

export interface TruncateToolOutputsOptions {
  // Tool-result blocks with content longer than this trigger
  // truncation. Below this threshold, blocks pass through untouched —
  // small/medium outputs are fine as-is. Default 50_000, aligned with
  // Claude Code's persistence threshold.
  readonly triggerChars?: number;
  // Size of the preview substituted into the projection. Default 2000.
  readonly previewChars?: number;
  // When true, the preview is cut at the last newline within the
  // preview budget so mid-line cuts don't produce ragged output.
  // Falls back to a hard cut if there's no newline. Default true.
  readonly cutAtNewline?: boolean;
  // Name of the `recall` tool the model should call to fetch the
  // full content. Leave as default `recall` if the `recall`
  // extension is installed with default config; otherwise pass the
  // matching name. If the tool isn't installed, the hint in the
  // truncation message points to a non-existent tool — the truncation
  // still works, the model just can't recover the rest through this
  // channel.
  readonly recallToolName?: string;
}

// Projection transform that truncates oversized tool.result blocks on
// the way to the LLM. The underlying event log keeps the full content;
// truncation only affects what inference sees. Pairs with the `recall`
// extension: the hint in the truncation message tells the model to
// call `recall({ seqs: [N] })` to recover the full output on demand.
//
// Rationale: large tool outputs (bash stdout, grep results, file reads)
// flood the context window with stuff the model has usually already
// summarized mentally. Truncating at the projection layer — rather than
// per-tool at run time — keeps one truthful copy (the log), lets every
// tool produce its natural output, and gives the model a reliable
// recovery path when it actually needs the full data.
export const truncateToolOutputs = (
  opts: TruncateToolOutputsOptions = {},
): Extension => {
  const triggerChars = opts.triggerChars ?? 50_000;
  const previewChars = opts.previewChars ?? 2_000;
  const cutAtNewline = opts.cutAtNewline ?? true;
  const recallToolName = opts.recallToolName ?? "recall";

  return Layer.scopedDiscard(
    Effect.gen(function* () {
      const ctx = yield* AgentCtx;
      yield* ctx.addTransform({
        name: "truncate-tool-outputs",
        run: (blocks, tctx) => {
          // Re-check every projection whether the recall tool is live.
          // `tctx.tools` is pre-resolved by the projection driver, which
          // subscribes to the tools ref — so recall getting added or
          // removed triggers a reprojection and this transform re-runs
          // with a fresh snapshot.
          const hasRecall = tctx.tools.some((t) => t.name === recallToolName);
          return blocks.map((b) => {
            if (
              b.tag !== "core/tool-result" ||
              typeof b.content !== "string" ||
              b.content.length <= triggerChars
            ) {
              return b;
            }
            const seq = b.eventSeq;
            const preview = makePreview(b.content, previewChars, cutAtNewline);
            const pointer =
              hasRecall && seq !== undefined
                ? `Call ${recallToolName}({ seqs: [${seq}] }) to read the full output, or spawn a subagent to process it in a fresh context window.`
                : `Full content is not available to read back in this session — spawn a subagent to process this large output in a fresh context window, or re-run the command with narrower arguments.`;
            const total = b.content.length;
            return {
              ...b,
              content:
                `[output truncated — ${preview.length} of ${total} chars shown. ${pointer}]\n\n${preview}`,
            };
          });
        },
      });
    }),
  );
};

const makePreview = (
  content: string,
  previewChars: number,
  cutAtNewline: boolean,
): string => {
  if (content.length <= previewChars) return content;
  const head = content.slice(0, previewChars);
  if (!cutAtNewline) return head;
  const lastNewline = head.lastIndexOf("\n");
  // Only cut at newline if it's reasonably close to the end of the
  // preview — otherwise a newline near the start would shrink the
  // preview too aggressively. Inclusive at the midpoint so the cut
  // fires on the exact 50% boundary rather than falling through.
  if (lastNewline >= previewChars * 0.5) return head.slice(0, lastNewline);
  return head;
};
