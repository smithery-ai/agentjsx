# EffectCtx

EffectCtx lets you build agent harnesses by composing steering extensions that shape what your model sees and does. It's inspired by React's rendering model: just as the DOM is rendered from state, an agent's context is *rendered* from an append-only event log.

## Install

```bash
bun add effectctx
# or
npm install effectctx
```

## Quickstart

A local coding agent with sandboxed file system + shell access and recall over its own log:

```ts
import { createAgent, createAiGatewayInfer } from "effectctx";
import { recall } from "effectctx/extensions";
import { localWorkspace } from "effectctx/node";

const agent = createAgent({
  infer: createAiGatewayInfer({ model: "anthropic/claude-sonnet-4-6" }),
  extensions: [
    localWorkspace({ root: "/tmp/agent" }),
    recall(),
  ],
});

await agent.send("find every TODO in this repo and group them by file");
```

`localWorkspace` is the Node-flavored shorthand for the `workspace` extension. It lives in `effectctx/node` because it pulls in `node:fs/promises` and `node:child_process`. The core `effectctx` package stays platform-agnostic, so the same agent runs unchanged on Cloudflare Workers (with Sandbox-backed adapters) or any other V8 runtime. See [`examples/cloudflare-sandbox/`](examples/cloudflare-sandbox/) for the Workers version.

## From events to context

Every agent has one source of truth: an append-only log of events. The model never sees that log directly. It sees a context that's rendered from the log on every turn.

```
world
  │  user types, tools run, agent replies
  ▼
events  (append-only log)
  │  project each event into a fragment
  ▼
fragments  (one per event)
  │  steering extensions reshape the array
  ▼
fragments  (after extensions)
  │  render into the final shape the model sees
  ▼
context  (system + messages + tools)
```

## Steering extensions

A steering extension is a small piece of logic that shapes what the model sees and does. The quickstart above composes two:

- `localWorkspace`: shell + file system rooted at one directory. Gives the model `bash`, `read_file`, `write_file`, `list_dir`, `grep`, plus a live tree ambient. (Wraps the underlying `workspace` extension with Node host adapters.)
- `recall`: registers a tool the model can call to fetch older log entries that were compacted or truncated.

Drop in more as you need them: `compact` and `summarize` for context compaction, `truncateToolOutputs` to clip oversized tool results, `mcpServers` to mount remote tools, `subagents` to let the agent spawn helpers, `maxSteps` to cap inference loops. See [docs/architecture.md](docs/architecture.md) for the full catalog.

Each one lives in [src/extensions/](src/extensions/) and is usable on its own. Reorder the array, swap one out, or delete a line, and the agent keeps working with one fewer behavior.

## Writing your own steering extension

The built-in extensions use the same primitive you do. Here's one that enforces a rule: block edits to a file until the model has read it. A common safety rule in coding agents.

```ts
import { Effect, Layer, Schema } from "effect";
import { readFile, writeFile } from "node:fs/promises";
import { AgentCtx, defineTool, type Extension } from "effectctx";

// A custom steering extension: provides `read` and `edit` tools.
// `edit` refuses to write to a file until `read` has seen it.
export const readBeforeEdit = (): Extension =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const ctx = yield* AgentCtx;
      const seen = new Set<string>();

      yield* ctx.addTool(
        defineTool({
          name: "read",
          description: "Read a file's contents.",
          parameters: Schema.Struct({ path: Schema.String }),
          run: async ({ path }) => {
            seen.add(path);
            return await readFile(path, "utf8");
          },
        }),
      );

      yield* ctx.addTool(
        defineTool({
          name: "edit",
          description: "Edit a file. The file must be read first.",
          parameters: Schema.Struct({
            path: Schema.String,
            contents: Schema.String,
          }),
          run: async ({ path, contents }) => {
            if (!seen.has(path)) {
              return `Refusing to edit ${path}: read it first so you know what's there.`;
            }
            await writeFile(path, contents);
            return `Wrote ${contents.length} chars to ${path}.`;
          },
        }),
      );
    }),
  );
```

Drop it into your agent the same way:

```ts
extensions: [
  localWorkspace({ root: "/tmp/agent" }),
  readBeforeEdit(),
],
```

The rule lives in the extension, not the prompt. Delete the line, the rule disappears.

## Examples

Two complete, runnable examples:

- [`examples/coding-agent/`](examples/coding-agent/): ~80 lines, a local Node CLI that gives the agent shell + file system access on the host. Best place to read first.
- [`examples/cloudflare-sandbox/`](examples/cloudflare-sandbox/): the same agent embedded in a Cloudflare Worker, with shell + file system backed by a [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/) for real isolation.

## Docs

- [Architecture](docs/architecture.md): philosophy, primitives, the full extension catalog.
- [Extensions](docs/extensions.md): mental model, progressive shapes, writing your own.
- [Cookbook](docs/cookbook.md): worked recipes for common patterns.
- [Hydration](docs/hydration.md): replaying logs, restoring agents across restarts.
- [API reference](docs/api.md): every export and type.
- [Skill](docs/skill.md): condensed quickstart for models writing effectctx code.

## License

MIT. See [LICENSE](LICENSE).
