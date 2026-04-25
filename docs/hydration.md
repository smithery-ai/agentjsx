# Hydration

Because the log is the source of truth, an agent can be torn down and rebuilt from its events without losing state. This is hydration. It's what makes effectctx safe across crashes, restarts, and migrations between processes.

## Why it works

The four primitives that compose into the projection have different durability stories:

- **The log** is the only durable surface. It's append-only and serializable.
- **Ambients** re-materialize on every projection. Their content comes from `Effect<string>` callbacks that close over current state.
- **Transforms** are pure functions of `(Fragment[], TransformContext) => Fragment[]`. No state.
- **Tools** register at extension-load time. Their definitions are deterministic from the extensions installed.

Replay the events, install the same extensions, and you have the same agent. Nothing else needs to be persisted.

## Constructing an agent from a saved log

`createAgent` and `createAgentRuntime` accept an `initialEvents` array. Pass the events you've stored and the agent starts from that prefix.

```ts
import { createAgentRuntime, createAiGatewayInfer } from "effectctx";
import { localWorkspace } from "effectctx/node";

// Loaded from your durable store (Postgres row, KV value, DO state, etc.).
const savedEvents = await store.loadEvents(sessionId);

const agent = createAgentRuntime({
  infer: createAiGatewayInfer({ apiKey, model: "anthropic/claude-sonnet-4-6" }),
  extensions: [localWorkspace({ root })],
  initialEvents: savedEvents,
});

// The projection already reflects every saved event. The model picks up
// where it left off on the next agent.send(...).
```

The extensions install BEFORE the first inference fires on the seeded events, so any transforms or ambients are in place when the projection renders the rehydrated context.

## What gets restored automatically

Anything reachable from the events themselves:

- Prior user messages, assistant messages, and tool results.
- The rendered context the model sees on the next turn.
- `agent.result()`, `agent.events()`, halt status, in-flight tool calls (from `tool.call.started` events without matching `tool.result` events).
- Compaction state (collapsed by the projection from `compaction.summary` events).
- Anything an ambient derives from the log.

## What does not

State that wasn't in the log to begin with:

- Closure-local variables in extensions (e.g. the `seen` Set in the `readBeforeEdit` recipe). Starts empty after rehydrate.
- Per-agent `Ref`s an extension created in its layer body. Starts at the `Ref.make(initial)` value.
- In-process subagent state (the parent's view of a subagent comes back; the subagent's own runtime does not).
- Sandboxes, MCP server processes, or other external resources the agent was talking to.

The fix for state you do want to survive: emit it as an event. If the `seen` Set in `readBeforeEdit` mattered across restarts, the extension would emit a custom event when a path is read and rebuild the set from the log on rehydrate.

## Reconciling in-flight tool calls

`reconcileHydrationDangling` resolves the dangling-tool-call case: a process crashed after emitting `tool.call.started` but before the matching `tool.result` landed. On rehydrate, the dangling call needs a synthetic resolution so the projection stays provider-valid (most providers reject a context where a `tool_calls` block has no answering `tool` block).

```ts
import { makeEventLog, reconcileHydrationDangling } from "effectctx";

const log = makeEventLog(savedEvents);
await reconcileHydrationDangling(log);

// Now safe to hand `log` to createAgentRuntime.
```

`reconcileHydrationDangling` appends a synthetic `tool.result` event for each dangling call with a stub message ("Tool call interrupted by restart") so the projection has a complete pair. Call it once, right after constructing the log from saved events and before the first inference fires.

## Hydration and compaction

Compaction does not mutate the log. It appends a `compaction.summary` event that the projection collapses at render time. So a hydrated agent sees the same compacted view as the original, and removing the compaction transform always restores the full history.

```ts
// Same log, two different views.
const fullView = createAgentRuntime({ infer, initialEvents: events });
const compactedView = createAgentRuntime({
  infer,
  initialEvents: events,
  extensions: [compact({ summarize })],
});

// fullView shows the entire transcript. compactedView shows the same
// transcript with summary boundaries collapsed. Drop `compact` from the
// extensions array and you're back to fullView.
```

This is principle 1 paying out: the log never lies, the projection is always derivable.

## Hydration and extensions

Extensions are re-installed on rehydrate, which re-registers their tools and ambients. Anything the extension derives from the log is fine. Anything held in extension-local closures or refs starts fresh.

If you want extension-local state to survive, two patterns work:

1. **Emit it as an event.** Define a custom event type, append it from inside `tool.run` via `ToolOutcome.extraEvents`, project it back into a ref on layer install. The log carries the state across restarts.
2. **Externalize it.** Read/write the state from a store the extension is given at construction time. The log doesn't know about it, but the store survives independently.

Pattern 1 is the principled effectctx answer. Pattern 2 is fine for things that genuinely live elsewhere (MCP server connections, file handles, network sockets).

## Testing hydration

Snapshot the events, dispose the agent, build a new one from the snapshot, assert the projection matches.

```ts
import { describe, expect, it } from "vitest";
import { createAgentRuntime } from "effectctx";
import { scriptedInfer } from "./helpers/scripted-infer";

it("hydrates to the same context after restart", async () => {
  const buildAgent = (initialEvents = []) =>
    createAgentRuntime({
      infer: scriptedInfer([{ content: "ok" }]),
      initialEvents,
    });

  const a1 = buildAgent();
  void a1.send("hello");
  await a1.until((s) =>
    s.events.find((e) => e.type === "assistant.message") ?? null,
  );
  const events = await a1.events();
  const beforeRestart = await a1.rendered();
  await a1.dispose();

  const a2 = buildAgent(events);
  const afterRestart = await a2.rendered();
  expect(afterRestart.messages).toEqual(beforeRestart.messages);
  await a2.dispose();
});
```

The check that matters is `messages` equality (or full `ProviderContext` equality). If those match, the model sees the same context after restart as it did before, which is the whole guarantee hydration provides.
