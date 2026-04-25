# Skill: build agents with `effectctx`

Condensed instructions for models building agents on the `effectctx` package. For the full docs, see [architecture.md](architecture.md) and [extensions.md](extensions.md).

## Mental model

The runtime projects four inputs into the model-visible fragment array:

1. **Log**: append-only event stream and source of truth.
2. **Ambients**: ordered system-prefix contributors.
3. **Transforms**: pure `Fragment[] -> Fragment[]` shaping passes.
4. **Tools**: callable capabilities registered by extensions.

Extensions write to those inputs. Inference reads the projection.

## Start small

### Bare agent

```ts
import { createAgent, createAiGatewayInfer } from "effectctx";

const agent = createAgent({
  system: "You are a concise assistant.",
  infer: createAiGatewayInfer({
    model: "anthropic/claude-sonnet-4-6",
  }),
});
```

### One tool

```ts
import { defineTool } from "effectctx";
import { Schema } from "effect";

const readFile = defineTool({
  name: "read_file",
  parameters: Schema.Struct({ path: Schema.String }),
  run: async ({ path }) => files[path] ?? `not found: ${path}`,
});
```

### Stateful runtime

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

## Rules that matter

- **Log is the source of truth.** Prefer events over private mutable state.
- **Tools return outcomes.** Let the runtime write tool events; do not write into the log from inside `tool.run`.
- **Call `ctx.invalidate()`.** If an extension-owned ref affects an ambient or transform, invalidate after each write unless the change already flows through the log.
- **Use `ctx.render` inside subscribed fibers.** Do not read materialized derived state (`ctx.rendered`) from a fiber that also subscribes to the upstream log.
- **Compose extensions instead of probing each other.** Hidden behavioral coupling creates an implicit test matrix.

## Decision table

| Need | Use |
| --- | --- |
| Static instruction text | `system` on `createAgent` |
| Live ambient context | `ctx.addAmbient(...)` |
| New capability | `defineTool(...)` + `ctx.addTool(...)` |
| Hide or shrink existing content | transform |
| Recover compacted content | `recall()` |
| Wait for a result | `agent.until(...)` |

## Read next

- [Architecture](architecture.md): philosophy, primitives, full extension catalog.
- [Extensions](extensions.md): progressive shapes, writing your own.
- [Cookbook](cookbook.md): worked recipes.
- [Hydration](hydration.md): replaying and reconciling logs.
- [API reference](api.md): exports and types.
