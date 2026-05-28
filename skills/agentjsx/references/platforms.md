# Platforms

agentjsx ships per-runtime adapters under `src/platforms/`. Each adapter
fills the `platform` slot on `createAgentRuntime({ platform, ... })`,
which is the Effect `Layer` that resolves services like `FileSystem`,
`Path`, and `CommandExecutor` for capability components.

The `platform` layer is what `runEffect` resolves against at tool-call
time. If a component asks for `FileSystem` and the platform layer
doesn't provide it, you'll get a runtime error string the LLM sees,
not a compile error.

## What works today

| Runtime | Subpath | Status | What the layer provides |
|---|---|---|---|
| Node | `@flamecast/agentjsx/node` | Working | `nodeShell`, `nodeFileStore`, `localWorkspace` shorthand. Pair with `NodeContext.layer` from `@effect/platform-node` for the full `FileSystem`/`Path`/`CommandExecutor` surface that `<Workspace>` needs. |
| Bun | `@flamecast/agentjsx/platforms/bun` | Working | Re-exports `BunContext` + `BunRuntime` from `@effect/platform-bun`. `platform = BunContext.layer` gives you the full surface natively. `<Workspace>` works without modification. |
| Browser | `@flamecast/agentjsx/platforms/browser` | Partial | Exports `partialPlatform` (fetch-backed `BrowserHttpClient`) plus the rest of `@effect/platform-browser`. **No `FileSystem`, no `CommandExecutor`** — `<Workspace>` tools will return error strings unless you supply your own in-memory layer. `<Block>`, `<Messages>`, `<Compact>`, `<McpServer>` (over HTTP), `<Todo>` work fine. |
| Worker / Cloudflare | none | Not implemented | No upstream unified context from `@effect/platform`. If you need this, compose your own layer from primitives. |

## Picking and wiring a platform

### Node

```tsx
import { createAgentRuntime, render } from "@flamecast/agentjsx"
import { Agent, Workspace } from "@flamecast/agentjsx/components"
import { NodeContext } from "@effect/platform-node"

const agent = createAgentRuntime({
  infer: myInfer,
  platform: NodeContext.layer,
  context: () => render(
    <Agent>
      <Workspace root="./" />
    </Agent>
  ),
})
```

For local-dev shell + filesystem tools without going through
`<Workspace>`, use `localWorkspace({ root })` from
`@flamecast/agentjsx/node` — it's a shorthand that builds a host-process
`Shell` + real-disk `FileStore` and hands them to the underlying
`workspace` extension.

### Bun

```tsx
import { createAgentRuntime, render } from "@flamecast/agentjsx"
import { Agent, Workspace } from "@flamecast/agentjsx/components"
import { platform } from "@flamecast/agentjsx/platforms/bun"

const agent = createAgentRuntime({
  infer: myInfer,
  platform,
  context: () => render(
    <Agent>
      <Workspace root="./" />
    </Agent>
  ),
})
```

`platform` is `BunContext.layer`. For lifecycle handling parity with
`NodeRuntime.runMain`, use `BunRuntime.runMain` from the same subpath.

### Browser (limited)

```tsx
import { createAgentRuntime, render } from "@flamecast/agentjsx"
import { Agent, Block, Messages, Compact, McpServer } from "@flamecast/agentjsx/components"
import { partialPlatform } from "@flamecast/agentjsx/platforms/browser"

const agent = createAgentRuntime({
  infer: myFetchBackedInfer,
  platform: partialPlatform,
  context: () => render(
    <Agent>
      <Block name="role">You are a browser-side assistant.</Block>
      <McpServer name="remote" url="https://example.com/mcp" />
      <Compact strategy="snip" threshold={4000}>
        <Messages />
      </Compact>
    </Agent>
  ),
})
```

Do **not** mount `<Workspace>` here unless you bring your own
`FileSystem` + `CommandExecutor` layer (e.g., in-memory FS, no-op
shell). The default browser layer cannot back those tools.

### Worker / Cloudflare

No first-party adapter. Compose what you need from `@effect/platform`
primitives:

- HTTP client: `HttpClient` over `fetch`.
- KV / R2 / D1: write a small `Layer` that exposes those bindings as
  Effect services, then merge with whatever subset of `@effect/platform`
  you can support.
- Avoid `<Workspace>` unless you back `FileSystem`/`CommandExecutor`
  with a sandboxed adapter.

## Common gotchas

- `runEffect`'s public signature pins `R = never` for ergonomic
  composition inside Promise-returning `Tool.run` callbacks. The
  runtime resolves whatever the `platform` layer provides at execution
  time — the `as unknown as Effect.Effect<A, E, never>` cast at the
  call site is the intended pattern.
- `<Workspace>` requires `FileSystem` + `Path` + `CommandExecutor`. If
  the platform layer doesn't supply all three, tool calls return error
  strings the model sees. This is by design — agents handle it the
  same way they'd handle any tool error — but it's the most common
  source of "why is my agent confused" on browser/worker runtimes.
- `@flamecast/agentjsx/node` does not re-export `NodeContext`. Import
  it directly from `@effect/platform-node` and pass to `platform`.
