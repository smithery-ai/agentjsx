# agentctx

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

## Why agentctx

LLM context is a view. It changes every turn: messages land, the workspace shifts, todos tick off, errors surface and resolve. React-the-DOM is the closest analog, and after a decade we know how to compose views.

- `<Workspace root="./" />`: bash, read, write, grep, ls and a live tree
- `<Skills root="./skills" />`: `skill_lookup`, `skill_invoke`, and a menu of available skills
- `<McpServer name="linear" url="..." />`: every tool the MCP server exposes
- `<Block name="role">...</Block>`: any text in a named system block
- `<Messages />`: the running user, assistant, and tool conversation (auto-pulls from the agent's event log; pass `from={...}` to project a custom subset)
- `<Todo />`: a todo list that ticks off as the agent works
- `<Errors />`: recent tool failures so the agent stops repeating broken approaches
- `<GitState />`: current branch, dirty state, recent commits

The runtime walks the tree every turn, diffs against the previous render, and applies the changes.

## Install

```bash
bun add @flamecast/agentjsx
```

Built on [Effect](https://effect.website). Runs on Node, Cloudflare Workers, or any V8 runtime.

## Examples

- [`examples/coding-agent/`](examples/coding-agent/): local Node CLI with shell and file system access.
- [`examples/cloudflare-sandbox/`](examples/cloudflare-sandbox/): the same agent inside a Cloudflare Sandbox.

## License

MIT.
