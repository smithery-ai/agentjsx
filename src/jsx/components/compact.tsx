// <Compact> — a unified wrapping shaper component. Walks its children
// into a fresh local collector via `renderChildren`, applies a
// strategy-specific transform to the message-shaped subset of emitted
// fragments, then re-emits everything (preserved + transformed + tools)
// into the outer collector.
//
// This is the JSX-side mirror of the projection-time transforms in
// `src/extensions/{snip,truncate-tool-outputs,clip-messages}.ts`. The
// difference: those extensions run at projection time over the FULL
// fragment stream; <Compact> scopes the transform to whatever subtree
// it wraps. That makes the shaping local and compositional — multiple
// <Compact>s in one tree shape different subtrees independently, and
// nesting just chains the transforms (inner runs first, outer runs over
// the inner's output).
//
// The pure transform bodies are inlined here rather than imported from
// the extensions. The extension files entangle the transform with an
// Effect Layer + `ctx.addTransform` registration; for the MVP, the
// duplication is short and keeps Compact free of an Effect-runtime
// dependency at render time. If the shapes diverge later we can refactor
// the extensions to export a pure helper.
//
// `summary` strategy is intentionally NOT included in this PR — that
// shape requires async LLM work (the `summarize` extension forks a fiber
// against `ctx.rendered.changes`) which doesn't fit the synchronous
// render walk. Deferred.

import type { Fragment as RenderedFragment } from "../../types";
import { emitFragment, emitTool, type Element, type Node } from "../runtime";
import { renderChildren } from "../render";

export type CompactProps =
  | {
      readonly strategy: "snip";
      // Keep the most recent N message-shaped fragments. Older ones are
      // dropped and a single system marker is inserted in their place.
      readonly keepRecent: number;
      readonly children?: Node | ReadonlyArray<Node>;
    }
  | {
      readonly strategy: "truncate-tool-outputs";
      // Tool-result fragments longer than this character budget get
      // replaced with a preview + recall hint.
      readonly limit: number;
      readonly children?: Node | ReadonlyArray<Node>;
    }
  | {
      readonly strategy: "clip-messages";
      // Per-fragment character cap. Each message-shaped fragment whose
      // content exceeds this is clipped to `limit` chars with a suffix.
      readonly limit: number;
      readonly children?: Node | ReadonlyArray<Node>;
    };

// "Message-shaped" = fragments contributed by history projection (and
// downstream shapers that preserve the `source: "history"` convention).
// Mirrors `src/extensions/snip.ts`'s discrimination so a <Compact
// strategy="snip"> wrapping <Messages /> drops the same fragments the
// projection-time `snip` extension would. System blocks (role, skills,
// workspace, todo, ambient markers) carry non-history `source` values
// and pass through untouched.
function isMessageShaped(f: RenderedFragment): boolean {
  return f.source === "history";
}

function defaultSnipMarker(droppedCount: number): string {
  return `[${droppedCount} earlier conversation turn${droppedCount === 1 ? "" : "s"} omitted]`;
}

function makePreview(content: string, previewChars: number): string {
  if (content.length <= previewChars) return content;
  const head = content.slice(0, previewChars);
  const lastNewline = head.lastIndexOf("\n");
  if (lastNewline >= previewChars * 0.5) return head.slice(0, lastNewline);
  return head;
}

// Strategy: snip. Keep only the last `keepRecent` message-shaped
// fragments; drop the rest. Mirrors snip.ts including the pair-aware
// orphan-trim — a kept slice that leads with `core/tool-result` is
// invalid (its parent assistant.message was dropped), so we trim
// leading orphan tool-results from the head.
function applySnip(
  messages: ReadonlyArray<RenderedFragment>,
  keepRecent: number,
): ReadonlyArray<RenderedFragment> {
  if (messages.length <= keepRecent) return messages;
  let slice = messages.slice(-keepRecent);
  while (slice.length > 0 && slice[0].tag === "core/tool-result") {
    slice = slice.slice(1);
  }
  const dropped = messages.length - slice.length;
  const marker: RenderedFragment = {
    tag: "core/system",
    content: defaultSnipMarker(dropped),
    source: "compact/snip",
  };
  return [marker, ...slice];
}

// Strategy: truncate-tool-outputs. Replace oversized tool-result content
// with a preview + a generic recovery hint. (The projection-time
// extension probes for the `recall` tool to choose between a direct
// pointer and a generic hint; <Compact> runs at JSX render time where
// the tools surface isn't trivially available, so we use the universal
// fallback message. Operators who want the recall-aware pointer should
// install the `truncateToolOutputs` extension at the runtime layer
// instead.)
function applyTruncateToolOutputs(
  messages: ReadonlyArray<RenderedFragment>,
  limit: number,
): ReadonlyArray<RenderedFragment> {
  return messages.map((b) => {
    if (
      b.tag !== "core/tool-result" ||
      typeof b.content !== "string" ||
      b.content.length <= limit
    ) {
      return b;
    }
    const preview = makePreview(b.content, limit);
    const total = b.content.length;
    return {
      ...b,
      content:
        `[output truncated — ${preview.length} of ${total} chars shown. Spawn a subagent to process this large output in a fresh context window, or re-run the command with narrower arguments.]\n\n${preview}`,
    };
  });
}

// Strategy: clip-messages. Cap each message-shaped fragment's content
// at `limit` chars with a `[truncated]` suffix. Preserves the most
// recent user message verbatim — matches `clipMessages` extension's
// `preserveLastUser: true` default; the pending user turn is the
// question the agent is about to answer, and silently clipping a long
// document with the real ask near the end is the failure mode we want
// to avoid.
function applyClipMessages(
  messages: ReadonlyArray<RenderedFragment>,
  limit: number,
): ReadonlyArray<RenderedFragment> {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].tag === "core/user-message") {
      lastUserIdx = i;
      break;
    }
  }
  return messages.map((b, i): RenderedFragment => {
    if (i === lastUserIdx) return b;
    if (b.content.length <= limit) return b;
    return { ...b, content: b.content.slice(0, limit) + "\n[truncated]" };
  });
}

export function Compact(props: CompactProps): Node {
  const inner = renderChildren(
    (props.children ?? []) as Node | ReadonlyArray<Node>,
  );

  // Partition fragments into "shape these" (message-shaped, source ===
  // "history") vs "leave alone" (system blocks, ambient capability
  // fragments, compaction summaries). Preserved order within each
  // partition is the original emission order — we re-emit non-messages
  // first, then transformed messages, which matches the convention used
  // by `snip` (system markers before history slice).
  const messages: RenderedFragment[] = [];
  const preserved: RenderedFragment[] = [];
  for (const f of inner.fragments) {
    if (isMessageShaped(f)) messages.push(f);
    else preserved.push(f);
  }

  let transformed: ReadonlyArray<RenderedFragment>;
  switch (props.strategy) {
    case "snip":
      transformed = applySnip(messages, props.keepRecent);
      break;
    case "truncate-tool-outputs":
      transformed = applyTruncateToolOutputs(messages, props.limit);
      break;
    case "clip-messages":
      transformed = applyClipMessages(messages, props.limit);
      break;
  }

  const emits: Element[] = [
    ...preserved.map((f) => emitFragment(f)),
    ...transformed.map((f) => emitFragment(f)),
    ...inner.tools.map((t) => emitTool(t)),
  ];
  return emits as Node;
}
