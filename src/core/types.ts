// Core data types for the harness runtime. These are plain structural
// interfaces with no runtime dependency — shared across the Effect
// runtime, extensions, and any external consumer (callers, adapters,
// tests, CLIs).

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

export type ProviderOptions = Record<string, JsonObject>;

// The data a tool produces for a single invocation. Plain string is the
// common case — the content becomes the `tool.result` event's body and
// nothing else changes in the log.
//
// The richer `{ content, extraEvents }` form lets a tool declare
// structural events the framework should append alongside its
// `tool.result`. Canonical use: `compact` tool emits a
// `compaction.summary` event so the projection can collapse covered
// history; the `tool.result` is just a human-readable confirmation.
// The framework appends `extraEvents` FIRST, then the `tool.result`,
// in a single atomic `appendMany` batch so seq order is deterministic
// and a crash between the two is impossible.
//
// Tool bodies stay pure functions (args in, data out). The framework
// remains the only actor that writes to the log — this is just a
// generalization of "tool.result is the one append" to "the tool can
// declare additional structural appends it needs."
// Distributive "event minus seq" — preserves each union member's own
// keyset so a `compaction.summary` literal doesn't get collapsed. Same
// shape as EventInput in event-log.ts; kept inline here to avoid a
// circular import.
type EventDataInput = Event extends infer E
  ? E extends { seq: number }
    ? Omit<E, "seq">
    : never
  : never;

export type ToolOutcome =
  | string
  | {
      readonly content: string;
      readonly extraEvents?: ReadonlyArray<EventDataInput>;
    };

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolOutcome>;
}

export interface ToolContext {
  [key: string]: unknown;
}

// Events are the append-only source of truth. Each carries a monotonic seq.
//
// `tool.call.started` is an intent beacon: it's appended BEFORE a tool's
// side effects run so a crash mid-`tool.run` can be reconciled on resume
// by pairing unmatched started-events with synthetic interrupted results.
// It does not project to a block — the LLM only sees `assistant.message`
// with `tool_calls` and the matching `tool.result`.
export type Event = { seq: number } & (
  // `content` is the validated input value. For agents using the implicit
  // default (no `inputSchema` export), content is a string. For agents
  // exporting `inputSchema = z.object({...})` (or any non-string Zod),
  // content is whatever the schema validates to. Projection serializes
  // non-string content via JSON.stringify so the LLM block stays string.
  | { type: "user.message"; content: unknown }
  | { type: "assistant.message"; content: string; tool_calls?: ToolCall[] }
  | { type: "tool.call.started"; tool_call_id: string; tool_name: string }
  | { type: "tool.result"; tool_call_id: string; content: string }
  | { type: "assistant.halted"; reason: string }
  // The InferFn threw. Without this event, the inference loop's
  // `Effect.catchAll` swallows the error into `ctx.errors` (an internal
  // channel) and any `agent.until` predicate keeps waiting forever — a
  // real silent-hang failure mode. With this, the loop is terminal:
  // predicates can match it, the runtime can decide retry/halt, and
  // consumers see a real failure instead of a stuck-`running` session.
  // `cause` is the unwrapped error message; the full structured error
  // is also pushed to `ctx.errors` for stack-trace access.
  | { type: "inference.failed"; cause: string; phase: string }
  // Additive compaction boundary. Declares that events in [fromSeq, toSeq]
  // are summarized by `text`. The projection collapses the covered range
  // into a single system block at render time; the underlying events are
  // never mutated, so hydrating a persisted log replays boundaries
  // naturally. Stack additively — multiple boundaries at different
  // ranges each contribute one summary block in order.
  | {
      type: "compaction.summary";
      fromSeq: number;
      toSeq: number;
      text: string;
      prompt?: string;
    }
  // Todo state mutations emitted by the `<Todo>` component's tools. Not
  // projected into the LLM-facing message stream — they're internal
  // state for the Todo block's ambient render. The block reduces over
  // these events at render time to derive the current items list.
  | { readonly type: "todo.added"; readonly text: string }
  | { readonly type: "todo.completed"; readonly index: number }
  // Background subagent lifecycle. Emitted by the `<Subagent>` component's
  // tools. `subagent.started` is appended atomically with the
  // `spawn_agent` tool's result; the spawn fires a forked task on the
  // parent's ManagedRuntime that runs the child, then appends either
  // `subagent.completed` or `subagent.failed` directly to the parent's
  // log when the child finishes. The `<Subagent>` block reduces over
  // these events at render time to surface in-flight subagents to the
  // model. None project to the message stream — the model sees status
  // via the ambient block and via `check_agent` tool results.
  | { readonly type: "subagent.started"; readonly id: string; readonly prompt: string }
  | { readonly type: "subagent.completed"; readonly id: string; readonly content: string }
  | { readonly type: "subagent.failed"; readonly id: string; readonly error: string }
);

// Fragments are the LLM-facing projection of events + extension contributions,
// post-transforms. `source` names the extension that contributed the fragment
// (or "history" for event-derived fragments). `eventSeq` links to the source event
// when applicable.
//
// `cacheControl` opts into provider-side prompt caching. Providers that
// don't support caching ignore it; providers that do (Anthropic via
// AI Gateway, etc.) mark this fragment as a cache breakpoint — everything
// up to and including this fragment is cached for the TTL. Typical use:
// set on the last long-lived ambient fragment (skills menu, workspace
// tree) so system prompt + all ambient state caches together.
export type CacheControl =
  | { type: "ephemeral" }
  | { type: "ephemeral"; ttl: "1h" };

// Tag-keyed discriminated union of fragment variants. Core tags are
// prefixed `"core/"`. Extensions may declare their own variants via
// TypeScript module augmentation:
//
//   declare module "@flamecast/harness" {
//     interface FragmentMap {
//       "skills/index": { content: string; skills: readonly SkillEntry[]; cacheControl?: CacheControl }
//     }
//   }
//
// The `content: string` field is always present — it's what the adapter
// renders to the provider. Additional structured fields enable
// downstream transforms to discriminate without content-sniffing.
export interface FragmentMap {
  "core/system":             { content: string; cacheControl?: CacheControl };
  "core/user-message":       { content: string; eventSeq: number };
  "core/assistant-message":  { content: string; toolCalls?: ToolCall[]; eventSeq: number };
  "core/tool-result":        { content: string; toolCallId: string; eventSeq: number };
  "core/compaction-summary": { content: string; covered: readonly [number, number] };
}

// Distributive mapped type: one arm per key in FragmentMap, each carrying
// its own `tag` literal plus the required `source` field. Module
// augmentation adds arms automatically.
export type Fragment = {
  [K in keyof FragmentMap]: FragmentMap[K] & { tag: K; source: string };
}[keyof FragmentMap];

// Output of the JSX render walk (see `src/jsx/render.ts`). Components
// emit into one of these channels via `emitFragment` / `emitTool` /
// `emitCommand`. The runtime consumes a `Rendered` to seed
// `ctx.ambients`, `ctx.tools`, and slash commands at startup.
// Additional channels (transforms, forked effects) are reserved for
// future stages — not implemented yet.
export interface Rendered {
  readonly fragments: ReadonlyArray<Fragment>;
  readonly tools: ReadonlyArray<Tool>;
  readonly commands: ReadonlyArray<import("../jsx/runtime").Command>;
}

export interface InferResponse {
  content: string;
  tool_calls?: ToolCall[];
}

// Ephemeral streaming token emitted during inference. Never appended to
// the event log — purely for live-streaming to session observers.
export interface TextDelta {
  readonly turnId: string;
  readonly text: string;
}

export interface InferOptions {
  // Called once per streamed text chunk during inference. Optional —
  // providers that don't support streaming ignore it.
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
}

// Tool declaration as providers see it — name + description + JSON schema
// parameters. Distinct from the runtime `Tool` type which also carries `run`.
// The terminal render adapter emits these into `ProviderContext.tools`.
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

// Provider-compatible message — alternating user/assistant, plus tool turns.
// Shape matches the OpenAI Chat Completions / Anthropic common denominator. The
// adapter transform is the only place this shape is built and the only
// place the alternating-messages invariant is enforced.
export type ProviderMessage =
  | { readonly role: "user"; readonly content: string | ReadonlyArray<ProviderContentChunk> }
  | {
      readonly role: "assistant";
      readonly content: string | ReadonlyArray<ProviderContentChunk>;
      readonly toolCalls?: readonly ToolCall[];
    }
  | {
      readonly role: "tool";
      readonly toolCallId: string;
      readonly content: string | ReadonlyArray<ProviderContentChunk>;
    };

// Per-chunk content entry. Used when a message carries per-chunk
// metadata (currently `cacheControl` for Anthropic-style prompt caching).
export interface ProviderContentChunk {
  readonly type: "text";
  readonly text: string;
  readonly cacheControl?: CacheControl;
}

// Provider-ready output of the render pipeline. The adapter transform
// builds this from the Fragment stream + TransformContext and is the
// terminal step — everything after this point is provider HTTP.
export interface ProviderContext {
  readonly system: string | ReadonlyArray<ProviderContentChunk>;
  readonly messages: readonly ProviderMessage[];
  readonly tools: readonly ToolDefinition[];
}

export type InferFn = (context: ProviderContext, opts?: InferOptions) => Promise<InferResponse>;
