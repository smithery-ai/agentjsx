import type { ProviderContext } from "./types";

// Provider-shape invariants checked at render preflight time — i.e.
// just before the inference loop calls `infer(context)`. Anything that
// would predictably 4xx/5xx upstream is caught here with a diagnostic
// pointing at the offending message, much cheaper to debug than the
// provider's generic `messages: …` rejection.
//
// Why this lives in core: the inference loop runs the preflight (so the
// failure surfaces as a normal `inference.failed` event before any wire
// call). Provider modules re-export from here for ergonomic naming.
//
// Invariants enforced:
//   - assistant turns must have either non-empty text OR ≥1 tool_call.
//     Both empty (text="" + no tool_calls) is what Anthropic, OpenAI,
//     and most other providers reject (Anthropic's exact wording: "text
//     content blocks must be non-empty"). Reproduced in the wild via
//     cloud-claude integration when an extension's tool produced a pure
//     tool_call assistant turn — see effectctx PR description.
//
// Deliberately conservative — we don't check "every tool message has a
// preceding assistant tool_call" because compaction boundaries
// legitimately collapse the assistant turn that emitted the call while
// leaving the tool message standing, and compaction-aware providers
// handle this. Adding more invariants is fine when they're
// compaction-aware.
//
// Returns null when the context is valid; a string diagnostic
// otherwise. Callers should refuse to dispatch the inference call and
// instead surface the diagnostic (via `inference.failed`).
export function validateProviderContext(
  context: ProviderContext,
): string | null {
  for (let i = 0; i < context.messages.length; i++) {
    const m = context.messages[i];
    if (m.role !== "assistant") continue;
    const text =
      typeof m.content === "string"
        ? m.content
        : m.content.map((c) => c.text).join("");
    const hasText = text.length > 0;
    const hasCalls = !!(m.toolCalls && m.toolCalls.length > 0);
    if (!hasText && !hasCalls) {
      return `assistant message at index ${i} is empty (no text and no tool_calls); upstream providers reject empty assistant turns`;
    }
  }
  return null;
}
