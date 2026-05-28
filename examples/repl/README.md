# REPL example

Interactive prompt → reply loop against an agentjsx agent. The simplest end-to-end demo: type a message, watch tool calls + assistant replies stream into your terminal — with real filesystem and shell access via `@effect/platform-node`.

```bash
cd examples/repl
pnpm install
AI_GATEWAY_API_KEY=sk-... pnpm start
```

Or under Infisical (Smithery contributors with workspace access):

```bash
infisical run --silent -- pnpm start
```

You'll see something like:

```
agentjsx REPL  ·  ctrl-c to exit

you    list the workspace
  → calling list_dir
  ← cli.tsx
    package.json
    pnpm-lock.yaml
    README.md
    tsconfig.json
agent  Here are the files in the current directory: cli.tsx, package.json, README.md, tsconfig.json.
```

## What's in `cli.tsx`

- `createAgentRuntime` wired up with `platform: NodeContext.layer`, giving the `<Workspace>` tools real `FileSystem`, `Path`, and `Command` services from `@effect/platform-node`.
- A JSX `context` tree: a persona block, `<Workspace root="./" />` for fs/shell tools, `<Todo />` for multi-step task tracking, and `<Messages />` for the running conversation.
- A `readline` loop that sends each line as a user message, then polls `agent.events()` to print tool calls and assistant replies as they land.

## Effect lifecycle

The program is wrapped in `NodeRuntime.runMain` from `@effect/platform-node`. That gives us:

- SIGINT / SIGTERM interception (no manual `process.on("SIGINT", ...)`).
- Automatic finalizer execution on shutdown: `agent.dispose()` and `rl.close()` are both registered with `Effect.addFinalizer` and run via `Effect.scoped`.
- Correct process exit codes — a `Effect.die` on missing `AI_GATEWAY_API_KEY` exits non-zero with a pretty-printed cause.

The agentjsx public API stays Promise-based; the REPL bridges with `Effect.promise(() => agent.send(...))` and friends. Effect.gen orchestrates the loop, but the per-turn event-drain helper is left as a plain `async function` for readability.
