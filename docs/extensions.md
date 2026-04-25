# Extensions

`effectctx` ships the reactive authoring primitives used by `createAgent(...)` and a library of small, composable extensions you mix into the array you pass at construction time.

## Where to start

Use the package in three progressively more capable shapes:

1. `createAgent(...)` with an `infer` adapter when you want a working agent with no extra surface.
2. Add `tools` directly when the agent needs new capabilities but no shared state.
3. Add `extensions` when you want runtime behavior that holds state, ships ambient context, or reshapes the projection.

## Mental model

The runtime continuously projects four inputs into the fragment array seen by the model:

| Input | Purpose |
| --- | --- |
| Log | Append-only event stream and source of truth |
| Ambients | Ordered system-prefix contributors |
| Transforms | Pure `Fragment[] -> Fragment[]` shaping passes |
| Tools | Callable capabilities exposed to the model |

Extensions write to those inputs. Inference reads the resulting projection.

## Shape 1: bare agent

```ts
import { createAgent, createAiGatewayInfer } from "effectctx";

const agent = createAgent({
  system: "You are a concise assistant.",
  infer: createAiGatewayInfer({
    model: "anthropic/claude-sonnet-4-6",
  }),
});

await agent.send("hi");
const reply = await agent.until((snap) => {
  const last = snap.events.at(-1);
  return last?.type === "assistant.message" && last.content.length > 0 ? last : null;
});
await agent.dispose();
```

## Shape 2: add a tool

```ts
import { defineTool } from "effectctx";
import { Schema } from "effect";

const readFile = defineTool({
  name: "read_file",
  description: "Read a file by path.",
  parameters: Schema.Struct({ path: Schema.String }),
  run: async ({ path }) => files[path] ?? `not found: ${path}`,
});
```

Pass tools directly to `createAgent({ tools: [readFile], ... })`.

## Shape 3: stateful runtime

```ts
import {
  createAgent,
  createInMemoryStore,
  fileSystem,
  recall,
  truncateToolOutputs,
} from "effectctx";

const agent = createAgent({
  system: "You are a code explorer.",
  infer,
  extensions: [
    fileSystem(createInMemoryStore({ initial: { "README.md": "..." } })),
    recall(),
    truncateToolOutputs({ triggerChars: 10_000, previewChars: 1_500 }),
  ],
});
```

## Built-in extensions

| Extension | Purpose |
| --- | --- |
| `fileSystem(store)` | Ambient filesystem block plus file tools |
| `shell(...)` | Shell execution tools |
| `workspace(...)` | Common `shell` + `fileSystem` composition |
| `recall()` | Log-reading tool for compacted content |
| `truncateToolOutputs(...)` | Replace oversized tool bodies with previews and pointers |
| `clipMessages(...)` | Per-message clipping |
| `snip(...)` | Drop old history under a token budget |
| `summarize(...)` / `compact(...)` | Summarization-driven compaction |
| `maxSteps(...)` | Stop runaway loops |
| `skills(...)` | Expose reusable skill content |
| `subagents(...)` | Spawn child agents |
| `mcpServers(...)` | Mount one or more MCP servers as tools |
| `webSearch(...)` | Web search tool |

See [architecture.md](architecture.md) for source links and per-extension contracts.

## Writing an extension

An extension registers tools, ambients, transforms, or fibers against the runtime context:

```ts
import { Effect, SubscriptionRef, Schema } from "effect";
import { defineTool } from "effectctx";

export const counter = () => (ctx) =>
  Effect.gen(function* () {
    const n = yield* SubscriptionRef.make(0);

    ctx.addAmbient({
      name: "counter",
      content: Effect.map(SubscriptionRef.get(n), (v) => `count: ${v}`),
    });

    ctx.addTool(defineTool({
      name: "bump",
      parameters: Schema.Struct({}),
      run: () =>
        Effect.gen(function* () {
          yield* SubscriptionRef.update(n, (v) => v + 1);
          yield* ctx.invalidate();
          return "bumped";
        }),
    }));
  });
```

## Decision table

| Need | Use |
| --- | --- |
| Static instruction text | `system` on `createAgent` |
| Live ambient context | `ctx.addAmbient(...)` |
| New capability | `defineTool(...)` + `ctx.addTool(...)` |
| View shaping without rewriting history | transform |
| Recovery for truncated content | `recall()` with `truncateToolOutputs(...)` |
| Waiting for a result | `agent.until(...)` |

## Non-negotiable rules

- **Log first.** If state can be expressed as an event, prefer that over a private mutable ref.
- **Tools return data; the runtime writes events.** Use tool outcomes and extra events instead of writing directly from inside `tool.run`.
- **Invalidate owned state.** If an extension-owned ref affects an ambient or transform, call `ctx.invalidate()` after each write unless the write already flows through the log.
- **Derive inside subscribed fibers.** A fiber subscribed to log changes must use `ctx.render`, not the materialized `ctx.rendered`, or it can observe stale derived state.
- **Compose, do not probe.** When two extensions must cooperate for behavior, create a named composition rather than branching on whether another extension happens to be present.
