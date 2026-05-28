import type { Fragment, ProviderContext } from "../core/types";

// Rough character-to-token ratio. ~4 chars/token is a common first
// approximation for English text — used by Anthropic's and OpenAI's
// older guidance and by several agent frameworks when an exact
// tokenizer isn't available. Callers with a real tokenizer should
// override by passing their own `estimateTokens`.
export function estimateTokensFromFragments(blocks: Fragment[]): number {
  let chars = 0;
  for (const b of blocks) {
    chars += b.content.length;
    if (b.tag === "core/assistant-message" && b.toolCalls) {
      for (const tc of b.toolCalls) {
        chars += tc.function.name.length + tc.function.arguments.length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

// Estimate tokens from the final render output. Walks `system` +
// `messages` and counts characters; matches the fragment-level
// estimator's ~4 char/token heuristic. Used by `summarize` to decide
// when to fire after the pipeline has produced the provider context.
export function estimateTokensFromContext(context: ProviderContext): number {
  let chars = 0;
  if (typeof context.system === "string") {
    chars += context.system.length;
  } else {
    for (const chunk of context.system) chars += chunk.text.length;
  }
  for (const msg of context.messages) {
    if (typeof msg.content === "string") {
      chars += msg.content.length;
    } else {
      for (const chunk of msg.content) chars += chunk.text.length;
    }
    if (msg.role === "assistant" && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        chars += tc.function.name.length + tc.function.arguments.length;
      }
    }
  }
  return Math.ceil(chars / 4);
}
