# agentjsx (experimental)

A runtime agnostic agent harness framework for composing modern agents using reusable components in JSX.

## Install

```bash
bun add @flamecast/agentjsx
```

## Quickstart
Build a claude code like harness in a few lines of code:

```tsx
import { createAgentRuntime, createAiGatewayInfer, render } from "@flamecast/agentjsx"
import {
  Agent, Block, Messages,
  Workspace, Skills, McpServer, Todo, Subagent,
  Compact,
} from "@flamecast/agentjsx/components"
import { NodeContext } from "@flamecast/agentjsx/node"

const agent = createAgentRuntime({
  infer: createAiGatewayInfer({ model: "anthropic/claude-sonnet-4-6" }),
  platform: NodeContext.layer,
  context: () => render(
    <Agent>
      <Block name="role">You are a coding assistant.</Block>
      <Workspace root="./" />
      <Skills root="./skills" />
      <McpServer name="deepwiki" url="https://mcp.deepwiki.com/mcp" />
      <McpServer
        name="linear"
        url="https://mcp.linear.app/mcp"
        headers={{ Authorization: `Bearer ${process.env.LINEAR_API_KEY}` }}
      />
      <Todo />
      <Subagent>
        <Workspace root="./" />
      </Subagent>
      <Compact strategy="summary" threshold={4000}>
        <Messages />
      </Compact>
    </Agent>
  ),
})

await agent.run("Find the latest bug in Linear and open a PR fixing it.")
```

## Build your own component

A component is a function that returns one or more emits. Three shapes:

- **Content** — emits prompt fragments (`<Block>`, `<Messages>`).
- **Capability** — emits tools and optionally a fragment describing them (`<Workspace>`, `<Subagent>`).
- **Shaper** — wraps children and transforms what they emit (`<Compact>`).

Built-in capability components include `<Workspace>`, `<Skills>`, `<McpServer>`, `<Subagent>`, `<Todo>`, `<Memory>`, `<WebSearch>`, `<WebFetch>`. Drop any of them inside `<Agent>`:

```tsx
<Memory root="./.memory" />
<WebSearch apiKey={process.env.EXA_API_KEY!} />
<WebFetch />
```

A minimal capability:

```tsx
import { Schema } from "effect"
import { defineTool } from "@flamecast/agentjsx"
import { emitFragment, emitTool } from "@flamecast/agentjsx/components"

export function Clock() {
  const now = defineTool({
    name: "now",
    description: "Return the current ISO timestamp.",
    parameters: Schema.Struct({}),
    run: async () => new Date().toISOString(),
  })
  return [
    emitTool(now),
    emitFragment({
      tag: "core/system",
      source: "clock",
      content: "<clock>(call `now` for the current time)</clock>",
    }),
  ]
}
```

Drop `<Clock />` anywhere inside `<Agent>` and the model gets a `now` tool plus a one-line system block describing it. Tools are reconciled by name across renders — same name, no churn.

## Runtimes

```ts
// Node
import { NodeContext, NodeRuntime } from "@flamecast/agentjsx/node"
createAgentRuntime({ platform: NodeContext.layer, ... })
NodeRuntime.runMain(program)

// Bun
import { BunContext, BunRuntime } from "@flamecast/agentjsx/platforms/bun"
createAgentRuntime({ platform: BunContext.layer, ... })
BunRuntime.runMain(program)

// Browser — Workspace tools work via just-bash (in-memory VFS + bash interpreter)
import { justBashPlatform } from "@flamecast/agentjsx/platforms/browser"
createAgentRuntime({ platform: justBashPlatform({ files: { "/README.md": "..." } }), ... })
```

Node and Bun get real `bash` + native filesystem. Browser gets a POSIX-subset bash and an in-memory VFS via [`just-bash`](https://github.com/vercel-labs/just-bash) — no system binaries, but pipes, grep, awk, sed, find all work against files you seed into the VFS.

## Examples

- [`examples/repl/`](examples/repl/): interactive REPL against the agent. Type a message, watch tool calls + replies stream in.

## License

Apache 2.0.
