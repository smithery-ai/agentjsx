// Capability component — installs three tools on the parent that let
// the model spawn child agents. The component's JSX subtree defines
// what the subagents look like (their system prompt + tools).
//
// Tools:
//   - `agent({ prompt })`             — sync: spawn, await, return final text.
//   - `spawn_agent({ prompt })`       — background: start a child, return id immediately.
//   - `check_agent({ id })`           — poll the status/result of a backgrounded subagent.
//
// Background path: `spawn_agent` returns immediately with a
// `subagent.started` extraEvent. A fire-and-forget task scheduled onto
// the parent's ManagedRuntime then runs the child to completion and
// appends `subagent.completed` (or `subagent.failed`) directly to the
// parent's log. The ambient block renders the live in-flight list by
// reducing over those events, so the model is reminded what's
// outstanding without having to poll.
//
// Children are NOT emitted into the parent's tree. They live in a
// module-level slot (refreshed each parent render) and are only walked
// against the child runtime's own RenderContext when a subagent is
// spawned.

import type { Layer } from "effect";
import { Chunk, Effect, Schema } from "effect";
import { createAgentRuntime } from "../../core/agent";
import { AgentCtx } from "../../core/agent-ctx";
import { defineTool } from "../../core/define-tool";
import { isHalted, lastResult } from "../../core/projections";
import type { Event, InferFn } from "../../core/types";
import { render, useRenderContext } from "../render";
import { emitFragment, emitTool, type Element, type Node } from "../runtime";

export interface SubagentProps {
  // Defaults to the parent's `infer`. Override to run the subagent
  // against a different model.
  readonly infer?: InferFn;
  // Platform layer for the child runtime. Required when children
  // include capability components needing filesystem/shell.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly platform?: Layer.Layer<any, never, never>;
  readonly children?: Node | Node[];
}

interface SubagentSlot {
  children: Node | Node[] | undefined;
  infer: InferFn;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  platform: Layer.Layer<any, never, never> | undefined;
}

// Tools are reconciled by name; the tools' closures outlive a single
// render, so they read the latest captured state from this slot. The
// slot is refreshed on each parent render.
let slot: SubagentSlot | null = null;

function extractFinalText(events: ReadonlyArray<Event>): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "assistant.message" && (!e.tool_calls || e.tool_calls.length === 0)) {
      return e.content;
    }
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "assistant.halted") return e.reason;
    if (e.type === "inference.failed") return `[agent] inference failed: ${e.cause}`;
  }
  return "(subagent produced no output)";
}

function newId(): string {
  return `sa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Run a child runtime to completion and return its final text. Returns
// either the terminal assistant.message content, or a halt/error
// message. The child runtime is always disposed.
async function runChildToCompletion(active: SubagentSlot, prompt: string): Promise<string> {
  const child = createAgentRuntime({
    infer: active.infer,
    ...(active.platform ? { platform: active.platform } : {}),
    context: () => render((active.children ?? []) as Node),
  });
  try {
    await child.run(prompt);
    const final = await child.until((snap) => {
      const chunk = Chunk.fromIterable(snap.events);
      if (isHalted(chunk)) return snap.events;
      const result = lastResult(chunk);
      return result ? snap.events : null;
    });
    return extractFinalText(final);
  } finally {
    await child.dispose().catch(() => {});
  }
}

// Truncate a prompt for display in the ambient block. Keep it short so
// many concurrent subagents fit without blowing the system prefix.
function truncateForBlock(s: string, max = 80): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

interface InFlight {
  id: string;
  prompt: string;
}

interface Completed {
  id: string;
  ok: boolean;
}

function deriveSubagentState(events: ReadonlyArray<Event>): {
  inFlight: InFlight[];
  completed: Map<string, Completed>;
} {
  const started = new Map<string, string>(); // id → prompt
  const completed = new Map<string, Completed>();
  for (const e of events) {
    if (e.type === "subagent.started") started.set(e.id, e.prompt);
    else if (e.type === "subagent.completed") completed.set(e.id, { id: e.id, ok: true });
    else if (e.type === "subagent.failed") completed.set(e.id, { id: e.id, ok: false });
  }
  const inFlight: InFlight[] = [];
  for (const [id, prompt] of started) {
    if (!completed.has(id)) inFlight.push({ id, prompt });
  }
  return { inFlight, completed };
}

export function Subagent(props: SubagentProps): Node {
  const parentCtx = useRenderContext();

  slot = {
    children: props.children,
    infer: props.infer ?? parentCtx.infer,
    platform: props.platform,
  };

  // Schedule background work onto the parent's ManagedRuntime by
  // running an Effect that reaches AgentCtx and appends to the parent's
  // log. The `as unknown as ... R = never` cast is the standard
  // pattern in this codebase (see workspace.tsx) — the parent runtime
  // has AgentCtx provided; we just widen the call site without leaking
  // R into the caller.
  const appendToParent = (event: Event extends infer E ? E extends { seq: number } ? Omit<E, "seq"> : never : never): Promise<void> =>
    parentCtx.runEffect(
      Effect.gen(function* () {
        const ctx = yield* AgentCtx;
        yield* ctx.events.append(event);
      }) as unknown as Effect.Effect<void, never, never>,
    );

  const agent = defineTool({
    name: "agent",
    description:
      "Spawn a subagent on a focused task and wait for its final response. Use for short tasks where you want the answer inline. For long-running work that you want to fan out, use spawn_agent + check_agent instead.",
    parameters: Schema.Struct({ prompt: Schema.String }),
    run: async ({ prompt }) => {
      if (!slot) return "[agent] internal error: subagent slot missing";
      const active = slot;
      try {
        return await runChildToCompletion(active, prompt);
      } catch (e) {
        return `[agent] Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  const spawn_agent = defineTool({
    name: "spawn_agent",
    description:
      "Spawn a subagent in the background. Returns an id immediately; the subagent runs while you do other work. Poll its status with check_agent({ id }). Use this for long-running research tasks or to fan out multiple subagents in parallel.",
    parameters: Schema.Struct({ prompt: Schema.String }),
    run: async ({ prompt }) => {
      if (!slot) return "[spawn_agent] internal error: subagent slot missing";
      const active = slot;
      const id = newId();
      // Kick off background work. Not awaited — the runEffect promise
      // runs against the parent's ManagedRuntime, which holds AgentCtx
      // and will append the completion/failure event when the child
      // finishes. Errors are swallowed (the failure event is the
      // observable signal).
      void (async () => {
        try {
          const content = await runChildToCompletion(active, prompt);
          await appendToParent({ type: "subagent.completed", id, content }).catch(() => {});
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          await appendToParent({ type: "subagent.failed", id, error }).catch(() => {});
        }
      })();
      return {
        content: `Spawned subagent ${id}. Poll with check_agent({ id: "${id}" }).`,
        extraEvents: [{ type: "subagent.started", id, prompt }],
      };
    },
  });

  const check_agent = defineTool({
    name: "check_agent",
    description:
      "Check on a backgrounded subagent by id. Returns the final response if it's done, or a pending status if it's still running.",
    parameters: Schema.Struct({ id: Schema.String }),
    run: async ({ id }) => {
      try {
        return await parentCtx.runEffect(
          Effect.gen(function* () {
            const ctx = yield* AgentCtx;
            const events = yield* ctx.events.snapshot;
            let started = false;
            for (const e of Chunk.toReadonlyArray(events)) {
              if (e.type === "subagent.started" && e.id === id) started = true;
              else if (e.type === "subagent.completed" && e.id === id) {
                return `[done] ${e.content}`;
              } else if (e.type === "subagent.failed" && e.id === id) {
                return `[failed] ${e.error}`;
              }
            }
            return started
              ? `[pending] subagent ${id} still running`
              : `[unknown] no subagent with id ${id}`;
          }) as unknown as Effect.Effect<string, never, never>,
        );
      } catch (e) {
        return `[check_agent] Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  // Ambient block: in-flight subagents derived from the event log.
  // Reduces over events read from the render context so the block
  // updates whenever a subagent is started or completes — no second-
  // hand state, no race.
  const { inFlight } = deriveSubagentState(parentCtx.events);
  const blockContent =
    inFlight.length === 0
      ? "<subagents>(none running)</subagents>"
      : `<subagents>\n${inFlight
          .map((s) => `  - ${s.id}: ${truncateForBlock(s.prompt)}`)
          .join("\n")}\n</subagents>`;

  const emits: Element[] = [
    emitTool(agent),
    emitTool(spawn_agent),
    emitTool(check_agent),
    emitFragment({
      tag: "core/system",
      source: "subagent",
      content: blockContent,
    }),
  ];
  return emits as Node;
}
