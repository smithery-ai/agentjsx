# agentjsx

JSX-driven LLM context. Compose your agent like a React tree.

## Install

```bash
bun add @flamecast/agentjsx
```

## Quickstart

```tsx
import { createAgentRuntime, createAiGatewayInfer, render } from "@flamecast/agentjsx"
import {
  Agent, Block, Messages,
  Workspace, Skills, McpServer,
  Todo, Errors, GitState,
} from "@flamecast/agentjsx/components"

const agent = createAgentRuntime({
  infer: createAiGatewayInfer({ model: "anthropic/claude-sonnet-4-6" }),
  context: () => render(
    <Agent>
      <Block name="role">You are a coding assistant.</Block>
      <Workspace root="./" />
      <Skills root="./skills" />
      <Todo />
      <Errors />
      <GitState />
      <McpServer name="linear" url="https://mcp.smithery.run/linear" />
      <Messages />
    </Agent>
  ),
})

await agent.send("Fix the highest-priority bug in Linear and open a PR.")
```

## Examples

(Coming soon: full runnable examples are being rebuilt under `examples/`.)

## License

MIT.
