# API Reference

Surface exported by `effectctx`. The source of truth is [`src/index.ts`](../src/index.ts) and the per-extension files under [`src/extensions/`](../src/extensions/). This page is a quick lookup; for the conceptual background see [architecture.md](architecture.md) and [extensions.md](extensions.md).

## Agent

### `createAgent(options)`

```ts
createAgent(opts: AgentOptions): Effect.Effect<AgentCtx, never, AgentCtx | PendingSends | Scope.Scope>
```

The scoped Effect form. Installs extensions, forks the inference and tool-execution loops, returns the live `AgentCtx`. Use when you're inside an existing Effect program. The scope must outlive the agent.

### `createAgentRuntime(options)`

```ts
createAgentRuntime(opts: AgentOptions): Agent
```

The plain-object entry point. Wraps `createAgent` in a `ManagedRuntime` and returns an `Agent` with promise-returning accessors. Use this for almost everything; reach for `createAgent` only when integrating with another Effect runtime.

### `AgentOptions`

```ts
interface AgentOptions {
  readonly system?: string;
  readonly tools?: ReadonlyArray<Tool>;
  readonly extensions?: ReadonlyArray<Extension>;
  readonly infer: InferFn;
  readonly initialEvents?: ReadonlyArray<Event>;
  readonly cacheAmbient?: boolean; // default true
  readonly renderer?: Renderer;
}
```

`infer` is the only required field. `system` becomes the first ambient. `initialEvents` seeds the log for hydration. `cacheAmbient` controls whether a cache breakpoint is auto-placed at the end of the system prefix. `renderer` overrides how ambient + history fragments compose.

### `Agent`

```ts
interface Agent {
  send(input: unknown): Promise<void>;
  until<T>(predicate: (snapshot: AgentSnapshot) => T | null): Promise<T>;
  events(): Promise<ReadonlyArray<Event>>;
  rendered(): Promise<ProviderContext>;
  errors(): Promise<ReadonlyArray<AgentErrorEntry>>;
  pendingToolCalls(): Promise<ReadonlyArray<ToolCall>>;
  result(): Promise<Event | null>;
  eventChanges: Stream.Stream<Chunk.Chunk<Event>>;
  renderedChanges: Stream.Stream<ProviderContext>;
  errorChanges: Stream.Stream<Chunk.Chunk<AgentErrorEntry>>;
  dispose(): Promise<void>;
  runtime: ManagedRuntime.ManagedRuntime<AgentCtx | PendingSends, never>;
}
```

`send` resolves once the user.message has landed in the log. `until` blocks until a predicate over the snapshot returns non-null. The `Changes` streams replay the current value on subscribe.

### `AgentSnapshot`

```ts
interface AgentSnapshot {
  readonly events: ReadonlyArray<Event>;
  readonly rendered: ProviderContext;
  readonly errors: ReadonlyArray<AgentErrorEntry>;
}
```

Plain-array view passed into `until` predicates. Plain arrays so predicate authors don't need to know about `Chunk`.

### `Extension`

```ts
type Extension = Layer.Layer<never, never, AgentCtx | PendingSends | Scope.Scope>;
```

A scoped Layer over `AgentCtx`. Installs in `extensions: [...]` registration order. Finalizers run on agent disposal.

## Context

### `AgentCtx`

The runtime service extensions yield to. Surface:

| Field | Type | Purpose |
| --- | --- | --- |
| `events` | `EventLog` | Append-only event log. |
| `tools` | `SubscriptionRef<ReadonlyArray<Tool>>` | Currently advertised tools. |
| `ambients` | `SubscriptionRef<ReadonlyArray<AmbientProducer>>` | System-prefix contributors. |
| `transforms` | `SubscriptionRef<ReadonlyArray<Transform>>` | Projection-time shapers. |
| `errors` | `SubscriptionRef<Chunk<AgentErrorEntry>>` | Error log. |
| `rendered` | `SubscriptionRef<ProviderContext>` | Materialized projection. Read from UI / `until` only. |
| `addTool(tool)` | `Effect<void, DuplicateToolError, Scope>` | Register a tool. Removed on scope close. |
| `addAmbient(ambient)` | `Effect<void, never, Scope>` | Register an ambient. Removed on scope close. |
| `addTransform(transform)` | `Effect<void, never, Scope>` | Register a transform. Removed on scope close. |
| `render` | `Effect<ProviderContext>` | Compute the projection fresh from primary sources. Use inside subscribed fibers. |
| `invalidate()` | `Effect<void>` | Manually trigger a reprojection (for extension-owned reactive state outside the four primitives). |
| `reportError(scope, err)` | `Effect<void>` | Append to the error log. |

### `AmbientProducer`

```ts
interface AmbientProducer {
  readonly name: string;
  readonly content: string | Effect.Effect<string>;
  readonly cacheControl?: CacheControl;
}
```

`content` as `Effect<string>` re-materializes on every projection (live state). As `string` is constant.

### `Transform`

```ts
interface Transform {
  readonly name: string;
  readonly run: (fragments: Fragment[], tctx: TransformContext) => Fragment[];
}
```

`tctx` carries pre-resolved framework state. Don't reach into `SubscriptionRef` primitives from inside `run`; that creates a throwaway Effect runtime and hides the dependency from the projection driver.

### `TransformContext`

```ts
interface TransformContext {
  readonly tools: ReadonlyArray<Tool>;
}
```

Resolved snapshot of inputs the transform may need. Currently just `tools`.

### `Renderer` / `ProjectionInputs`

```ts
type Renderer = (inputs: ProjectionInputs) => Fragment[];
interface ProjectionInputs {
  readonly ambients: Fragment[];
  readonly events: ReadonlyArray<Event>;
}
```

Override how the four inputs compose into the pre-transform fragment array. Almost no one needs this; the default in `renderHistoryFragments` is correct.

## Tools

### `defineTool(options)`

```ts
defineTool<A>(opts: {
  name: string;
  description: string;
  parameters: Schema.Schema<A, any, never>;
  run: (args: A, context: ToolContext) => Promise<ToolOutcome>;
}): Tool
```

The hand-written tool helper. Validates args via Effect Schema, hands the decoded value to `run`. The encoded type is unconstrained (the model sends raw JSON); decode produces the typed `A`.

For optional fields the LLM may send as explicit `null`, use `Schema.optionalWith({ nullable: true })`.

### `Tool` / `ToolDefinition` / `ToolContext` / `ToolCall`

Low-level types. Most users only see them as the values flowing through `addTool` and `agent.pendingToolCalls()`. See `src/types.ts` for full shapes.

### `ToolOutcome`

```ts
type ToolOutcome =
  | string
  | { content: string; extraEvents?: EventInput[] };
```

What `tool.run` returns. The string shorthand becomes the `tool.result` content. The object form lets the tool declare additional events to append atomically alongside `tool.result`. Canonical use: the `compact` tool returns `{ content, extraEvents: [{ type: "compaction.summary", ... }] }` so the framework appends both events as one batch.

## Inference

### `runInference(infer)`

```ts
runInference(infer: InferFn): Effect<void, never, AgentCtx | Scope>
```

Forks the inference loop. Called automatically by `createAgent` / `createAgentRuntime`. You only call this directly if you're composing the runtime by hand.

### `runToolExecution()`

```ts
runToolExecution(): Effect<void, never, AgentCtx | Scope>
```

Forks the tool-execution loop. Same story as `runInference`.

### `InferFn` / `InferResponse`

```ts
type InferFn = (ctx: ProviderContext, opts: InferOptions) => Promise<InferResponse>;
```

The function shape every provider adapter implements. Receives the rendered context, returns the next assistant message (with optional tool calls).

### `ProviderContext` / `ProviderMessage` / `ProviderContentChunk`

The provider-ready shape the render-adapter folds the projection into: `{ system, messages, tools }`. This is what `agent.rendered()` exposes and what `infer` receives.

## Events

### `makeEventLog(initial?)`

```ts
makeEventLog(initial?: ReadonlyArray<Event>): Effect<EventLog>
```

Construct a fresh event log, optionally seeded with prior events for hydration.

### `EventLog`

```ts
interface EventLog {
  readonly snapshot: Effect<Chunk<Event>>;
  readonly changes: Stream<Chunk<Event>>;
  readonly append: (event: EventInput) => Effect<void>;
  readonly appendBatch: (events: ReadonlyArray<EventInput>) => Effect<void>;
}
```

The append-only log. Single writer: `tool-exec.ts` for tool results, the inference loop for assistant messages, `agent.send` for user messages. Tool authors never call `append` directly.

### `EventInput` / `Event`

```ts
type Event =
  | { seq: number; type: "user.message"; content: unknown }
  | { seq: number; type: "assistant.message"; content: string; tool_calls?: ToolCall[] }
  | { seq: number; type: "tool.call.started"; tool_call_id: string; tool_name: string }
  | { seq: number; type: "tool.result"; tool_call_id: string; content: string }
  | { seq: number; type: "assistant.halted"; reason: string }
  | { seq: number; type: "compaction.summary"; fromSeq: number; toSeq: number; text: string; prompt?: string };
```

The closed event union. `seq` is assigned by the log (you don't pass it). All event types live in `src/types.ts`; add new types there so hydration, projection, and tool-exec stay coordinated.

## Projections

### `renderHistoryFragments(events)`

```ts
renderHistoryFragments(events: Chunk<Event>): Fragment[]
```

The canonical event-to-fragment fold. Used by the default `Renderer`. Collapses `compaction.summary` ranges, pairs `tool.call.started` with `tool.result`, etc.

### Sniff helpers

```ts
isHalted(events: Chunk<Event>): boolean
lastResult(events: Chunk<Event>): Event | null
pendingToolCallsFromLog(events: Chunk<Event>): ReadonlyArray<ToolCall>
toolsInFlight(events: Chunk<Event>): boolean
```

Pure functions over the event log. Use these instead of materializing the whole projection when you only need to know "is the agent done?" or "is a tool still running?"

## Hydration

### `reconcileHydrationDangling(log)`

```ts
reconcileHydrationDangling(log: EventLog): Effect<void>
```

Appends synthetic `tool.result` events for any `tool.call.started` event without a matching `tool.result`. Call once after constructing a log from saved events, before the first inference. See [hydration.md](hydration.md).

## Errors

### Error types

```ts
class DuplicateToolError extends Effect.Data.TaggedError("DuplicateToolError") { ... }
class InferenceError extends Effect.Data.TaggedError("InferenceError") { ... }
class ToolExecutionError extends Effect.Data.TaggedError("ToolExecutionError") { ... }
type AgentError = InferenceError | ToolExecutionError;
```

`DuplicateToolError` is raised when two extensions register a tool with the same name (caught at install time, the agent fails to build). `InferenceError` and `ToolExecutionError` are recorded into `ctx.errors` rather than thrown, so a failing tool doesn't kill the agent.

## Pending sends

### `PendingSends` / `PendingSendsService`

The Effect service that handles user.message ingestion when the agent is mid-turn (tools still in flight). The service queues the input and replays it onto the log once the turn settles. You almost never touch this directly; `agent.send` uses it under the hood.

## Providers

### `createAiGatewayInfer(options)`

```ts
createAiGatewayInfer(opts: AiGatewayOptions): InferFn
```

Vercel AI Gateway adapter. Pass the gateway API key + `<provider>/<model>` id; get back an `InferFn` ready to hand to `createAgent`.

### `AiGatewayOptions`

```ts
interface AiGatewayOptions {
  apiKey: string;
  model: string;
  providerOptions?: ProviderOptions;
  temperature?: number;
  maxTokens?: number;
  spend?: { usd: number };
  costPer1k?: { input: number; output: number };
  onUsage?: (usage: AiGatewayUsage) => void;
  retryOnEmpty?: { maxAttempts: number };
  fetch?: typeof fetch;
}
```

`spend` enforces a hard ceiling per call. `onUsage` fires after every successful request so you can stream usage telemetry to your own log. `fetch` is the test/intercept seam.

### `AiGatewayUsage`

```ts
interface AiGatewayUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
```

Token counts from the gateway response.

## Fragments

### `Fragment` / `FragmentMap` / `CacheControl`

```ts
type Fragment =
  | { tag: "core/system"; content: string; source: string; cacheControl?: CacheControl; ... }
  | { tag: "core/user-message"; content: unknown; source: string; eventSeq: number; ... }
  | { tag: "core/assistant-message"; content: string; toolCalls?: ToolCall[]; ... }
  | { tag: "core/tool-result"; content: string; toolCallId: string; ... }
  | ...;
```

The fragment union the projection produces and transforms operate on. Each fragment carries `source` (which extension or projection step produced it) for diagnostics. See `src/types.ts` for the full set.

## `effectctx/extensions`

Per-extension exports. Constructors return `Extension`. See [architecture.md](architecture.md) for the full table; all of these are `import { name } from "effectctx/extensions"`:

| Extension | Returns | Notes |
| --- | --- | --- |
| `ambientCwd()` | `Extension` | Live cwd ambient. |
| `fileSystem(store, opts?)` | `Extension` | Tree ambient + file tools over a `FileStore`. |
| `shell(backend, opts?)` | `Extension` | `bash` + `cd` over a `Shell`. |
| `workspace(ws, opts?)` | `Extension` | `shell` + `fileSystem` rooted at one directory. |
| `mcpServers(specs)` | `Extension` | Mount many MCP servers. |
| `webSearch(opts?)` | `Extension` | Web search tool. |
| `recall(opts?)` | `Extension` | `read_log` for compacted/truncated content. |
| `skills(opts)` | `Extension` | Skill index ambient + `load_skill` tool. |
| `subagents(opts)` | `Extension` | `spawn_agent` tool plus a backend. |
| `summarize(opts)` | `Extension` | Threshold-driven compaction. |
| `compact(opts)` | `Extension` | Model-driven `compact` tool. |
| `snip(opts)` | `Extension` | Drop oldest history under a budget. |
| `clipMessages(opts)` | `Extension` | Per-fragment content cap. |
| `truncateToolOutputs(opts)` | `Extension` | Replace oversized tool bodies with previews. |
| `truncateTools(opts?)` | `Extension` | Clear stale tool-result bodies. |
| `maxSteps(limit)` | `Extension` | Safety stop after N inference rounds. |
| `createInMemoryStore(opts?)` | `FileStore` | In-memory `FileStore` for tests. |
| `inProcessBackend(opts)` | `SubagentBackend` | In-process subagent backend. |

## `effectctx/node`

Node-specific helpers. Pulls in `node:fs/promises` and `node:child_process`, so only resolve from this subpath in Node-shaped runtimes.

| Export | Returns | Notes |
| --- | --- | --- |
| `nodeShell()` | `Shell` | Host-process shell adapter. No isolation; trusted-host use only. |
| `nodeFileStore(root)` | `FileStore` | Real-disk `FileStore` scoped to one root. Path arguments from the model are joined under `root`. |
| `localWorkspace({ root, shell?, fileSystem? })` | `Extension` | Convenience: bundles `nodeShell()` + `nodeFileStore(root)` and hands them to `workspace`. |
