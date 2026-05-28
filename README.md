# agentjsx (experimental)

Compose agents using JSX.

## Install

```bash
bun add @flamecast/agentjsx
```

## Quickstart

```tsx
import { createAgentRuntime, createAiGatewayInfer, render } from "@flamecast/agentjsx"
import {
  Agent, Block, Messages,
  Workspace, Skills, McpServer, Todo,
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
      <Compact strategy="summary" threshold={4000}>
        <Messages />
      </Compact>
    </Agent>
  ),
})

await agent.run("Find the latest bug in Linear and open a PR fixing it.")
```

## Examples

- [`examples/repl/`](examples/repl/): interactive REPL against the agent. Type a message, watch tool calls + replies stream in.

## License

MIT.
