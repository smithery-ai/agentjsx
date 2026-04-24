# effectctx

an effect based agent harness.

```bash
bun add effectctx
# or
npm install effectctx
```

Composable primitives for conversational agents, built on [Effect](https://effect.website). Events, tools, extensions, inference — separated into clean modules you pick from as needed.

## Modules

- `effectctx` — core runtime, `createAgentRuntime`, fragments
- `effectctx/agent` — agent lifecycle
- `effectctx/agent-ctx` — context adapter
- `effectctx/compaction` — safe transcript compaction
- `effectctx/define-tool` — schema-first tool definitions
- `effectctx/errors` — typed errors (Data.TaggedError)
- `effectctx/event-log` — append-only stream of events
- `effectctx/extensions` — workspace, MCP, max-steps, etc.
- `effectctx/hydration` — rebuild state from event log
- `effectctx/inference` — provider-agnostic inference loop
- `effectctx/projections` — derive views from events
- `effectctx/providers` — AI SDK providers (Vercel gateway, etc.)
- `effectctx/render-adapter` — fragment → provider message shape
- `effectctx/tool-exec` — tool execution runtime

## Peer dependencies

- `@modelcontextprotocol/sdk` (optional, for MCP extensions)

## License

MIT © Arjun Kumar
