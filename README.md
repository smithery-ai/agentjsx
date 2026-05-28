# agentjsx (experimental)

A runtime agnostic agent harness framework for composing modern agents using reusable components in JSX.

## Install

```bash
bun add @flamecast/agentjsx
```

## Quickstart

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
