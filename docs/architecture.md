# Architecture

EffectCtx is the reactive core that turns an append-only event log into the context a model sees on each turn. This doc covers what it is and how it composes. [Extensions](extensions.md) covers how to build on top of it.

## Philosophy

### Log is the source of truth

Every side effect produces an event on [`ctx.events`](../src/event-log.ts). User messages, tool calls, tool results, assistant replies, compaction summaries, halts. All append-only. State not reachable from the log is second-class. Replay the log and you get the same state; dump the log and you see exactly what happened. Compaction does not rewrite history. It appends a `compaction.summary` event that the projection collapses at render time, so removing the transform restores the full view.

### Affordances, not policies

Every hardcoded agent decision is a bet against the next model release. The runtime sets the floor (primitives, adapters, invariants) and the model decides the rest. Methods that scale with model capability beat methods that substitute for it ([Sutton's bitter lesson](http://www.incompleteideas.net/IncIdeas/BitterLesson.html) applied to harness design).

| Ceiling (policy) | Floor (affordance) |
| --- | --- |
| Compact every N turns | `compact` tool, model invokes when ready |
| Inject last K messages | `read_log` tool, model retrieves what it needs |
| Drop old file contents | Truncate + `recall` pointer, model can recover |
| Inject every skill upfront | `load_skill` tool, model loads what fits |
| Auto-delegate on keyword | `spawn_agent` tool, model decides when to fork |

Hardcoding is still right for safety and cost (`maxSteps`, rate limits), structural choices (event types, primitives, adapters), and invariants the model can't see (cache breakpoint placement, fiber race-safety). Everything else: expose the capability and get out of the way.

### Progressive disclosure

Each turn should show a minimal context plus the tools to pull more in. Dumping every tool, file, and past message costs tokens and distracts the model.

- **Skills load on demand.** The ambient prefix is an index; full content enters context on `load_skill`.
- **The file tree is a handle.** `fileSystem` advertises the tree; contents enter on `read_file`.
- **History is addressable.** `recall` exposes the log by seq, so old turns stay out of active context until the model asks.
- **Truncated outputs leave a pointer.** `truncateToolOutputs` compacts large results and embeds a recovery pointer the model can expand.

### Steering is rendering

The context window is a finite, curated view of an unbounded world. A smarter model on the wrong slice underperforms a weaker model on the right one. The runtime is a rendering engine that turns the event log into the next context window, turn by turn. Better models don't dissolve the rendering problem; they raise what a good rendering is worth.

## Primitives

A projection composes four inputs into the `Fragment[]` a model sees. Extensions write to inputs; inference reads the projection. The canonical implementation is [`agent-ctx.ts`](../src/agent-ctx.ts).

### Log

An append-only [`SubscriptionRef<Chunk<Event>>`](../src/event-log.ts). Event types are centralized in [`types.ts`](../src/types.ts) so hydration, projection, and tool-exec handle them consistently. The log is never mutated. Append-only plus projection collapse covers every use case compaction would want mutation for.

### Ambients

Ordered contributors to the system prefix. Pass `system` in `AgentCtxOptions` and that string becomes the first entry; extensions add more via `ctx.addAmbient`. Content is a string or an `Effect<string>` that re-materializes on every projection. That is how ambient state stays current (e.g. `ambientCwd` closes over `getCwd()` so the directory line updates on its own after each `cd`). A `cacheControl` flag controls where provider-side cache breakpoints land.

### Transforms

Functions `Fragment[] -> Fragment[]`, applied in registration order after projection. The order each extension calls `addTransform` determines the order transforms apply at render time. Across extensions, the order is the order of the `extensions: [...]` array in the runtime config. The `tctx` argument carries pre-resolved framework state (e.g. `tctx.tools`); never reach into `SubscriptionRef` primitives from inside a transform body, since that creates a throwaway Effect runtime and hides the dependency from the projection driver.

Transforms reshape what the model sees without touching the log, so dropping one restores the original history.

### Tools

A `SubscriptionRef<Tool[]>` of advertised callables. Inference reads it on every turn; extensions read it for soft-detection. Tool `run` is a pure function that returns a `ToolOutcome`, and [`tool-exec.ts`](../src/tool-exec.ts) writes `extraEvents` first, then `tool.result`, atomically. Tool authors never call `ctx.events.append` directly.

### Projection

The four inputs compose into a `SubscriptionRef<Chunk<Fragment>>` maintained by a single projection fiber ([`projections.ts`](../src/projections.ts)). Two reads are exposed:

| | `ctx.rendered` | `ctx.render` |
| --- | --- | --- |
| Type | `SubscriptionRef<Chunk<Fragment>>` | `Effect<Chunk<Fragment>>` |
| Source | Materialized by the projection fiber | Computed fresh from primary sources |
| Safe inside fibers also subscribed to `events.changes`? | **No** | **Yes** |
| Right consumer | UI, `until` predicates, external observers | Inference loop, forked fibers |

A fiber that subscribes to `events.changes` and reads `ctx.rendered` can observe stale derived state, the classical FRP glitch. Regression test: `test/agentctx/core/inference-consistency*.test.ts`.

`ctx.invalidate` exists for extension-owned reactive state that lives outside the four standard inputs (a `Ref` read by an ambient or a transform). Without `invalidate`, writes to that ref don't trigger reprojection. Canonical use: [`summarize.ts`](../src/extensions/summarize.ts).

## Built-in extensions

Every extension lives in [`src/extensions/`](../src/extensions/) and is usable alone. Composition is named (see `workspace`), never implicit. Extensions may probe `ctx.tools` / `ctx.ambients` to annotate a user-facing message, but never to gate behavior. That's a composition.

| Extension | What it contributes | Source |
| --- | --- | --- |
| `ambientCwd` | Live cwd ambient | [ambient-cwd.ts](../src/extensions/ambient-cwd.ts) |
| `fileSystem` | Tree ambient + `read_file` / `write_file` / `list_dir` / `grep` tools over a `FileStore` | [file-system.ts](../src/extensions/file-system.ts) |
| `shell` | Shell execution tools over a `Shell` adapter | [shell.ts](../src/extensions/shell.ts) |
| `workspace` | Composition: `shell` + `fileSystem` rooted at one directory | [workspace.ts](../src/extensions/workspace.ts) |
| `mcpServers` | Mount many MCP servers with one spec list | [mcp-servers.ts](../src/extensions/mcp-servers.ts) |
| `webSearch` | Web search tool | [web-search.ts](../src/extensions/web-search.ts) |
| `recall` | `read_log` tool for compacted or truncated content | [recall.ts](../src/extensions/recall.ts) |
| `skills` | Skill index ambient + `load_skill` tool | [skills.ts](../src/extensions/skills.ts) |
| `subagents` | `spawn_agent` tool plus child-agent backend | [subagents.ts](../src/extensions/subagents.ts) |
| `summarize` | Threshold-driven compaction via `compaction.summary` events | [summarize.ts](../src/extensions/summarize.ts) |
| `compact` | Model-driven `compact` tool (same event contract as `summarize`) | [auto-compact.ts](../src/extensions/auto-compact.ts) |
| `snip` | Drop oldest history under a token budget | [snip.ts](../src/extensions/snip.ts) |
| `clipMessages` | Per-fragment content cap | [clip-messages.ts](../src/extensions/clip-messages.ts) |
| `truncateToolOutputs` | Replace oversized tool bodies with previews + recall pointer | [truncate-tool-outputs.ts](../src/extensions/truncate-tool-outputs.ts) |
| `truncateTools` | Clear stale tool-result bodies | [truncate-tools.ts](../src/extensions/truncate-tools.ts) |
| `maxSteps` | Safety stop for runaway loops | [max-steps.ts](../src/extensions/max-steps.ts) |

Supporting pieces: [`in-memory-store.ts`](../src/extensions/in-memory-store.ts) is the default `FileStore` for tests; [`in-process-backend.ts`](../src/extensions/in-process-backend.ts) is an in-process `SubagentBackend`.
