# REPL example

Interactive prompt to reply loop against an agentjsx agent, plus a one-shot non-interactive mode for scripting and e2e verification. Real filesystem and shell access via `@effect/platform-node`.

```bash
cd examples/repl
pnpm install

# Interactive REPL
AI_GATEWAY_API_KEY=sk-... pnpm start

# One-shot — pass the prompt as an argument
AI_GATEWAY_API_KEY=sk-... pnpm start "list every TODO in src/"

# One-shot — pipe prompt via stdin
echo "what's in the workspace?" | AI_GATEWAY_API_KEY=sk-... pnpm start --stdin

# One-shot with a remote MCP server attached
MCP_URL=https://mcp.example.com/server \
MCP_NAME=example \
AI_GATEWAY_API_KEY=sk-... \
  pnpm start "list the open issues from example"
```

## Environment variables

- `AI_GATEWAY_API_KEY` (required): Vercel AI Gateway key used by the inference adapter.
- `SMITHERY_TOKEN` (optional): bearer token sent to the Smithery MCP gateway via `Authorization: Bearer <token>`. The gateway URL itself is in `cli.tsx` as `SMITHERY_URL` — edit there to point at your profile. When the token is unset the `<McpServer>` still appears in the tree and renders a failed/auth-error state; the agent keeps working with the local loadout.

UX caveat: on the first turn the rendered MCP block and tool listing show as `(connecting...)` because the connection is fire-and-forget. By turn two the connection has resolved and the tools and the listing show up populated. This is the same shape as the Skills cache.

Under Infisical (Smithery contributors with workspace access):

```bash
infisical run --silent -- pnpm start                          # interactive
infisical run --silent -- pnpm start "fix the typo in README" # one-shot
```

In one-shot mode the program sends the prompt, waits for the terminal assistant turn, prints the reply (with tool-call commentary), and exits cleanly. Same agent, same JSX context, just no readline loop.

You'll see something like:

```
agentjsx REPL  ·  ctrl-c to exit

you    what conventions should I follow in this repo?
  → calling skill_lookup
  ← # Coding style…
agent  Use the coding-style skill: match surrounding style, read nearby files first, keep imports grouped…

you    list the workspace
  → calling list_dir
  ← cli.tsx
    package.json
    pnpm-lock.yaml
    README.md
    skills/
    tsconfig.json
agent  Files in the current directory: cli.tsx, package.json, README.md, skills/, tsconfig.json.
```

## What's in `cli.tsx`

The JSX `context` tree wires up the full demo loadout:

- `<Block name="role">` — the persona.
- `<Workspace root="./" />` — filesystem and shell tools backed by `@effect/platform-node`.
- `<Skills root={SKILLS_ROOT} />` — exposes the markdown files in `./skills/` to the agent. Emits a `<skills>` ambient block listing each skill with its one-line description, plus `skill_lookup` and `skill_invoke` tools the model can call to pull a skill body into context. First render shows `(loading...)`; subsequent renders (triggered by any agent event) show the populated listing.
- `<McpServer name={MCP_NAME} url={MCP_URL} />` (conditional on `MCP_URL`) — connects to an HTTP MCP server lazily on first render and exposes its tools to the agent namespaced as `<MCP_NAME>_<toolname>`. First render shows `(connecting to ...)`; subsequent renders show the ready or failed state. Omitted from the tree entirely when `MCP_URL` is unset.
- `<Todo />` — multi-step task tracking. State is event-log-based, so todos durably replay from the event stream. If you later layer session persistence on top, todos hydrate for free.
- `<Compact strategy="truncate-tool-outputs" limit={800}>` wrapping `<Messages />` — caps any single tool-result fragment at 800 characters with a preview and a recovery hint. Stops a single `cat` of a giant file or a noisy `npm install` from blowing out the context window. The wrap is local: only fragments emitted inside it (the history projection) get shaped; ambient blocks above stay untouched.

`SKILLS_ROOT` is resolved via `path.resolve(__dirname, "./skills")` so the example works regardless of the cwd you run it from.

## The `skills/` directory

Three opinionated skill fixtures suitable for a real coding agent:

- `coding-style.md` — match surrounding style, read nearby files, narrow exports.
- `pull-request.md` — title format, one concern per PR, rebase don't merge.
- `writeup.md` — lead with the conclusion, mechanism next, code last.

Drop in more `.md` files to extend the agent's vocabulary. The first non-heading line of each file becomes its description in the ambient listing.

## Effect lifecycle

The program is wrapped in `NodeRuntime.runMain` from `@effect/platform-node`. That gives us:

- SIGINT / SIGTERM interception (no manual `process.on("SIGINT", ...)`).
- Automatic finalizer execution on shutdown: `agent.dispose()` and `rl.close()` are both registered with `Effect.addFinalizer` and run via `Effect.scoped`.
- Correct process exit codes — a `Effect.die` on missing `AI_GATEWAY_API_KEY` exits non-zero with a pretty-printed cause.

The agentjsx public API stays Promise-based; the REPL bridges with `Effect.promise(() => agent.send(...))` and friends. `Effect.gen` orchestrates the loop, but the per-turn event-drain helper is left as a plain `async function` for readability.
