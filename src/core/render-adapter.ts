// Terminal render adapter: Fragment[] → ProviderContext.
//
// This is the final step of the render pipeline. Shapers (snip,
// truncate, clipMessages, etc.) operate on Fragment[] and compose in
// registration order; once they're done, this adapter walks the
// Fragment stream and builds the provider-ready shape:
//
//   - `system`: concatenated `core/system` + `core/compaction-summary`
//     content plus any unknown (module-augmented) tags. Kept as a
//     content-chunk array when any fragment carries `cacheControl`
//     so per-chunk cache breakpoints survive onto the wire; else a
//     plain string for minimal payload diff vs non-cached paths.
//   - `messages`: alternating user/assistant/tool built from
//     `core/user-message`, `core/assistant-message`, `core/tool-result`.
//   - `tools`: `ToolDefinition[]` sourced from `tctx.tools`.
//
// Owner of the auto-cache-breakpoint contract: if no fragment in the
// final result carries an explicit `cacheControl` and `cacheAmbient`
// is on, we stamp the last system-role fragment of the composed
// result. Every previous iteration had this logic split across
// `agent-ctx.ts` and `providers/openrouter.ts`; having it here keeps
// the invariant in one place.

import type {
  CacheControl,
  Fragment,
  ProviderContentChunk,
  ProviderContext,
  ProviderMessage,
} from "./types";
import type { TransformContext } from "./agent-ctx";

// Is this fragment "system-like" — i.e., folds into ProviderContext.system?
// `core/system` and `core/compaction-summary` are the known system-ish
// tags; unknown tags (from module augmentation) default to system here,
// matching the policy from PR 2's OpenRouter mapper.
function isSystemTag(tag: Fragment["tag"]): boolean {
  return (
    tag === "core/system" ||
    tag === "core/compaction-summary" ||
    (tag !== "core/user-message" &&
      tag !== "core/assistant-message" &&
      tag !== "core/tool-result")
  );
}

function fragmentCacheControl(f: Fragment): CacheControl | undefined {
  return "cacheControl" in f ? f.cacheControl : undefined;
}

export interface RenderAdapterOptions {
  // If true (default), the adapter stamps `cacheControl: ephemeral` on
  // the last system-role fragment of the composed result WHEN no
  // fragment already carries explicit `cacheControl`. Set false to
  // opt out entirely (providers that don't care either way are free
  // to ignore the marker anyway).
  readonly cacheAmbient?: boolean;
}

// Produce a ProviderContext from a Fragment[] + TransformContext. Pure
// function — called at the tail end of `ctx.render`.
export function adaptToProviderContext(
  fragments: ReadonlyArray<Fragment>,
  tctx: TransformContext,
  opts: RenderAdapterOptions = {},
): ProviderContext {
  const cacheAmbient = opts.cacheAmbient ?? true;

  // Step 1: auto-place cache breakpoint on the last system-role
  // fragment if none is set anywhere in the result. We clone the
  // fragment rather than mutating in place.
  let staged: Fragment[] = fragments.slice();
  if (cacheAmbient && staged.length > 0) {
    const anyExplicit = staged.some((f) => fragmentCacheControl(f));
    if (!anyExplicit) {
      let idx = -1;
      for (let i = staged.length - 1; i >= 0; i--) {
        if (staged[i].tag === "core/system") {
          idx = i;
          break;
        }
      }
      if (idx >= 0) {
        const target = staged[idx];
        if (target.tag === "core/system") {
          staged[idx] = { ...target, cacheControl: { type: "ephemeral" } };
        }
      }
    }
  }

  // Step 2: split into system-prefix chunks and conversational messages.
  // We walk once; contiguous system fragments that lead the stream are
  // gathered into `systemChunks`. Any system-like fragment that appears
  // after conversational traffic starts is also folded into the system
  // prefix (rare; historically compaction-summary fragments sit mid-
  // history but the default composer places them inline — see
  // projections.renderHistoryFragments). We preserve order within the
  // system prefix and discard nothing.
  const systemChunks: ProviderContentChunk[] = [];
  const messages: ProviderMessage[] = [];

  for (const f of staged) {
    if (f.tag === "core/user-message") {
      appendOrExtendUser(messages, f);
      continue;
    }
    if (f.tag === "core/assistant-message") {
      if (f.toolCalls && f.toolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: f.content,
          toolCalls: f.toolCalls,
        });
      } else {
        messages.push({ role: "assistant", content: f.content });
      }
      continue;
    }
    if (f.tag === "core/tool-result") {
      messages.push({
        role: "tool",
        toolCallId: f.toolCallId,
        content: f.content,
      });
      continue;
    }
    // System-ish (core/system, core/compaction-summary, or unknown
    // module-augmented tag) — fold into the system prefix.
    if (isSystemTag(f.tag)) {
      const cc = fragmentCacheControl(f);
      const chunk: ProviderContentChunk = cc
        ? { type: "text", text: f.content, cacheControl: cc }
        : { type: "text", text: f.content };
      systemChunks.push(chunk);
      continue;
    }
  }

  // Step 3: fold the system prefix. If no chunk carries cacheControl,
  // collapse to a single string for minimal wire diff. If any does,
  // emit the content-chunk array so per-chunk breakpoints survive.
  let system: ProviderContext["system"];
  const anyChunkCached = systemChunks.some((c) => c.cacheControl);
  if (systemChunks.length === 0) {
    system = "";
  } else if (anyChunkCached) {
    system = systemChunks;
  } else {
    system = systemChunks.map((c) => c.text).join("\n\n");
  }

  const tools = tctx.tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  return { system, messages, tools };
}

// Group consecutive user-role fragments into a single user message with
// a content-chunk array — mirrors the grouping the OpenRouter mapper
// did historically for consecutive same-role blocks when any carried
// cache_control. For user fragments without cacheControl this still
// folds into a single string on emit.
function appendOrExtendUser(
  messages: ProviderMessage[],
  f: Extract<Fragment, { tag: "core/user-message" }>,
): void {
  const last = messages[messages.length - 1];
  const cc = fragmentCacheControl(f);
  if (last && last.role === "user") {
    const prev = last.content;
    if (typeof prev === "string" && !cc) {
      messages[messages.length - 1] = {
        role: "user",
        content: `${prev}\n\n${f.content}`,
      };
      return;
    }
    const chunks: ProviderContentChunk[] = typeof prev === "string"
      ? [{ type: "text", text: prev }]
      : [...prev];
    const next: ProviderContentChunk = cc
      ? { type: "text", text: f.content, cacheControl: cc }
      : { type: "text", text: f.content };
    chunks.push(next);
    messages[messages.length - 1] = { role: "user", content: chunks };
    return;
  }
  if (cc) {
    messages.push({
      role: "user",
      content: [{ type: "text", text: f.content, cacheControl: cc }],
    });
    return;
  }
  messages.push({ role: "user", content: f.content });
}
