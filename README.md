# agentctx

```tsx
import { createAgentRuntime, createAiGatewayInfer, render } from "@flamecast/agentctx"
import {
  Agent, Block, Messages,
  Workspace, Skills, McpServer,
  Todo, Errors, GitState,
} from "@flamecast/agentctx/components"

const agent = createAgentRuntime({
  infer: createAiGatewayInfer({ model: "anthropic/claude-sonnet-4-6" }),
  context: ({ events }) => render(
    <Agent>
      <Block name="role">You are a coding assistant.</Block>
      <Workspace root="./" />
      <Skills root="./skills" />
      <Todo />
      <Errors />
      <GitState />
      <McpServer name="linear" url="https://mcp.smithery.run/linear" />
      <Messages from={events} />
    </Agent>
  ),
})

await agent.send("Fix the highest-priority bug in Linear and open a PR.")
```

LLM context is a view. It changes every turn: messages land, the workspace shifts, todos tick off, errors surface and resolve. React-the-DOM is the closest analog, and after a decade we know how to compose views.

Some components install tools and a system block (`<Workspace>`, `<Skills>`, `<McpServer>`). Some are pure prompt content (`<Block>`, `<Messages>`). Some track session state that changes mid-run (`<Todo>`, `<Errors>`, `<GitState>`). All of them are functions in a tree.

The runtime walks the tree every turn, diffs against the previous render, and applies the changes. JSX declares, Effect runs.

## Install

```bash
bun add @flamecast/agentctx
```

Built on [Effect](https://effect.website). Runs on Node, Cloudflare Workers, or any V8 runtime.

## Examples

- [`examples/coding-agent/`](examples/coding-agent/): local Node CLI with shell and file system access.
- [`examples/cloudflare-sandbox/`](examples/cloudflare-sandbox/): the same agent inside a Cloudflare Sandbox.

## License

MIT.
