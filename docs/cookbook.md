# Cookbook

Worked recipes for common steering-extension patterns. Each recipe is a self-contained extension you can drop into your agent's `extensions: [...]` array.

## Block edits to a file until the model has read it

A behavioral safety rule: the agent can only `edit` a file it has previously called `read` on. The rule lives in the extension, not the prompt.

```ts
import { Effect, Layer, Schema } from "effect";
import { readFile, writeFile } from "node:fs/promises";
import { AgentCtx, defineTool, type Extension } from "effectctx";

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

## Custom compaction strategy

The built-in `compact` extension takes a `summarize` function. Wire it to whatever model you want, with whatever rules you want.

```ts
import { compact } from "effectctx/extensions";

extensions: [
  compact({
    // Cheap-model summarizer focused on what the agent was doing.
    summarize: async (oldFragments) => {
      const transcript = oldFragments
        .map((f) => ("content" in f ? String(f.content) : ""))
        .join("\n\n");
      const reply = await callCheaperModel({
        system: "Summarize the prior agent activity in one paragraph. Preserve file paths, decisions, and unresolved questions.",
        user: transcript,
      });
      return reply;
    },
    tail: 8, // keep the last 8 events uncompacted
  }),
]
```

For a threshold-driven version that fires automatically once the projection crosses a token budget, swap to `summarize` from `effectctx/extensions`. Same `summarize:` callback, plus a `maxTokens` trigger.

## Wiring an MCP server

`mcpServers` accepts a list of server specs and mounts each server's tools under a slug. Pair it with `recall` so the model can reach back into compacted MCP outputs.

```ts
import { mcpServers, recall } from "effectctx/extensions";

extensions: [
  mcpServers([
    {
      name: "github",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GH_TOKEN! },
    },
    {
      name: "browser",
      url: "https://browser.example.com/mcp",
    },
  ]),
  recall(),
]
```

Tools appear to the model as `github.list_issues`, `browser.navigate`, etc. The slug prefix prevents name collisions when two servers expose tools with the same name.

## Spawning a subagent

`subagents` registers a `spawn_agent` tool that lets the parent agent fork a child with its own log, tools, and ambient state. Wire a backend that constructs the child runtime.

```ts
import { subagents, inProcessBackend } from "effectctx/extensions";

extensions: [
  subagents({
    backend: inProcessBackend({
      // Each spawned child gets its own agent runtime with this loadout.
      build: ({ task }) =>
        createAgentRuntime({
          system: `You are a focused subagent. Task: ${task}`,
          infer: createAiGatewayInfer({ model: "anthropic/claude-sonnet-4-6" }),
          extensions: [localWorkspace({ root: "/tmp/sub" })],
        }),
    }),
  }),
]
```

The parent invokes `spawn_agent({ task: "..." })`. The child runs to completion (or the parent's timeout), and the final `assistant.message` comes back as the tool result.

## Ambient context that updates every turn

`addAmbient` accepts a string or an `Effect<string>`. The `Effect<string>` form re-evaluates on every projection, so live state stays current without you wiring an event for every change.

```ts
import { Effect, Layer, Ref } from "effect";
import { AgentCtx, type Extension } from "effectctx";

export const focusFile = (initial = ""): Extension =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const ctx = yield* AgentCtx;
      const focusRef = yield* Ref.make(initial);

      yield* ctx.addAmbient({
        name: "focus-file",
        content: Effect.map(
          Ref.get(focusRef),
          (path) => path ? `## Currently focused: ${path}` : "",
        ),
      });

      // Expose a tool the model uses to update the focus.
      yield* ctx.addTool(/* ... defineTool that writes to focusRef ... */);
    }),
  );
```

If the ref is read by an ambient or transform, call `ctx.invalidate()` after each write so the projection re-fires. If the change already flows through an event the agent appended, the projection will fire on its own.

## Truncating large tool outputs with recall

`truncateToolOutputs` rewrites oversized tool-result fragments to short previews and embeds a recovery pointer. Pair with `recall` so the model has a tool to fetch the full content when it actually needs it.

```ts
import { recall, truncateToolOutputs } from "effectctx/extensions";

extensions: [
  // ... your tool extensions ...
  truncateToolOutputs({
    triggerChars: 10_000,
    previewChars: 1_500,
  }),
  recall(),
]
```

The model sees `[truncated, 47KB → 1.5KB; call recall({ seqs: [42] }) for full content]`. Most turns the preview is enough; the model only spends tokens on the full body when it actually needs to.

## Testing an extension in isolation

`createAgentRuntime` accepts a stub `infer` function, so you can drive an extension end-to-end without touching a real model.

```ts
import { describe, it, expect } from "vitest";
import { createAgentRuntime } from "effectctx";
import { scriptedInfer, toolCall } from "./helpers/scripted-infer";
import { readBeforeEdit } from "../src/read-before-edit";

it("refuses to edit before read", async () => {
  const agent = createAgentRuntime({
    infer: scriptedInfer([
      { content: "", tool_calls: [toolCall("e1", "edit", { path: "x.ts", contents: "..." })] },
      { content: "done" },
    ]),
    extensions: [readBeforeEdit()],
  });

  void agent.send("go");
  await agent.until((s) =>
    s.events.find((e) => e.type === "tool.result") ?? null,
  );

  const events = await agent.events();
  const result = events.find((e) => e.type === "tool.result");
  expect(result?.content).toMatch(/Refusing to edit/);
  await agent.dispose();
});
```

The same pattern (scripted inference + assert on the event log) covers any extension you write. Because the log is the source of truth, a test that inspects the event sequence is checking exactly what the model would have seen.
