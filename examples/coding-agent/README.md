# Coding agent

A ~140-line local coding agent built on effectctx. The whole thing fits in [`index.ts`](./index.ts).

## What it does

Composes two extensions:

- `workspace`: gives the model `bash`, `read_file`, `write_file`, `list_dir`, `grep`, etc., all rooted at one directory. Also contributes a live tree ambient so the model knows what files exist.
- `maxSteps`: hard stop after 20 inference rounds so a runaway loop can't burn through your wallet.

Provides two adapters the runtime needs:

- A **Shell adapter** that shells out on the host. Simplest possible backend; not isolated.
- A **FileStore adapter** scoped to a workspace root, so the agent can't read `/etc/passwd`.

## Run

```bash
cd examples/coding-agent
npm install
AI_GATEWAY_API_KEY=... npx tsx index.ts "find every TODO in this repo and group them by file"
```

The agent operates inside `./.agent-workspace/` (created on first run). Drop files in there to give it something to chew on.

## What to read in the source

- **Lines 30–60** show the `Shell` adapter shape. `effectctx` ships the `shell()` extension but not a backend, so you bring the isolation story you want.
- **Lines 70–110** show the `FileStore` adapter. Same dependency-inversion pattern.
- **Lines 130–150** are the agent itself: `createAgentRuntime` + an `extensions: [...]` array. Reorder the array, add your own extension, swap out `workspace` for `fileSystem` alone, and you have a different agent.

## Next steps

- Add `autoCompact` to keep the context bounded on long sessions. See [docs/cookbook.md](../../docs/cookbook.md).
- Replace the host shell adapter with a sandboxed one (Docker, Firecracker, e2b) before running the agent on anything you don't want broken.
- Swap `workspace` for the `readBeforeEdit` recipe from the cookbook to enforce read-before-write.
