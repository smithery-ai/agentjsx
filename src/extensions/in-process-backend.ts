import { Effect, Layer } from "effect";
import { AgentCtx } from "../core/agent-ctx";
import { createAgentRuntime, type Agent, type Extension } from "../core/agent";
import type { Event, InferFn } from "../core/types";
import type { SubagentBackend, SubagentSpawnOpts, SubagentTerminal } from "./subagents";

// Default in-process backend. Spawns children via `createAgentRuntime`
// in the same isolate as the parent.
//
// Each child owns a fresh ManagedRuntime and a matching scope. `abort`
// disposes that runtime, which terminates the child's inference and
// tool-execution fibers. The parent-scope binding is performed by the
// `subagents()` extension — see subagents.ts, which registers a
// parent-scope finalizer that calls `backend.abort(handle)` so parent
// disposal propagates to every live child.
//
// After a child reaches terminal, its agent reference is released so
// the entire runtime (log, blocks, subscriptions, extension state)
// becomes GC-eligible. The terminal Promise stays cached so repeat
// `wait(handle)` calls still return the same result.
export const inProcessBackend = (infer: InferFn): SubagentBackend => {
  interface Entry {
    agent: Agent | null;
    terminal: Promise<SubagentTerminal>;
    state: "running" | "done" | "failed";
  }
  const registry = new Map<string, Entry>();
  let nextId = 0;

  return {
    async spawn(opts: SubagentSpawnOpts) {
      const handle = `inproc-${++nextId}`;

      const childExtensions: Extension[] = [...opts.extensions];

      if (Object.keys(opts.sharedBlocks).length > 0) {
        const blockFactories = opts.sharedBlocks;
        const agentType = opts.agentType;
        // Parent-bound closures become child AmbientProducers with
        // Effect-valued content. The Effect re-runs on every child
        // block recompute (triggered by child log / tool / blockSource
        // changes) — giving a "lazy read" of parent state on each
        // child turn. If the closure throws, the block content
        // collapses to "" and the error is reported via the child's
        // ctx.reportError so one bad block can't crash the child.
        const sharedLayer: Extension = Layer.scopedDiscard(
          Effect.gen(function* () {
            const childCtx = yield* AgentCtx;
            for (const [blockName, fn] of Object.entries(blockFactories)) {
              yield* childCtx.addAmbient({
                name: blockName,
                content: Effect.suspend(() => {
                  try {
                    return Effect.succeed(fn());
                  } catch (err) {
                    return childCtx
                      .reportError(
                        `subagent:${agentType}:sharedBlock:${blockName}`,
                        err instanceof Error ? err : new Error(String(err)),
                      )
                      .pipe(Effect.as(""));
                  }
                }),
              });
            }
          }),
        );
        childExtensions.push(sharedLayer);
      }

      const child = createAgentRuntime({
        ...(opts.systemPrompt ? { system: opts.systemPrompt } : {}),
        infer,
        tools: opts.tools,
        extensions: childExtensions,
        initialEvents: opts.initialEvents,
      });

      child.send(opts.prompt);

      const terminal: Promise<SubagentTerminal> = (async () => {
        try {
          const t = await child.until<SubagentTerminal>((snapshot) =>
            readTerminal(snapshot),
          );
          const current = registry.get(handle);
          if (current) {
            current.state = t.kind === "result" ? "done" : "failed";
          }
          return t;
        } catch (err) {
          const current = registry.get(handle);
          if (current) current.state = "failed";
          return {
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
          };
        } finally {
          await child.dispose().catch(() => {});
          const current = registry.get(handle);
          if (current) current.agent = null;
        }
      })();

      const entry: Entry = { agent: child, state: "running", terminal };
      registry.set(handle, entry);
      return { handle };
    },

    async wait(handle: string) {
      const entry = registry.get(handle);
      if (!entry) {
        return { kind: "error", message: `unknown handle: ${handle}` };
      }
      return entry.terminal;
    },

    async status(handle: string) {
      const entry = registry.get(handle);
      if (!entry) return "failed";
      return entry.state;
    },

    async abort(handle: string, _reason?: string) {
      const entry = registry.get(handle);
      if (!entry) return;
      if (entry.agent) {
        await entry.agent.dispose().catch(() => {});
        entry.agent = null;
      }
      entry.state = "failed";
    },
  };
};

// Inline terminal predicate. Matches the signals defaultAgentTerminal
// semantics: a settled assistant.message (no pending tool_calls) wins;
// an assistant.halted event forces halted; otherwise the first error
// entry surfaces as the terminal failure.
const readTerminal = (snapshot: {
  events: ReadonlyArray<Event>;
  errors: ReadonlyArray<{ phase: string; error: unknown }>;
}): SubagentTerminal | null => {
  const events = snapshot.events;
  // Search for a terminal assistant.message — the last event must be an
  // assistant.message with no pending tool_calls.
  const last = events.length > 0 ? events[events.length - 1] : null;
  if (
    last &&
    last.type === "assistant.message" &&
    (!last.tool_calls || last.tool_calls.length === 0)
  ) {
    return { kind: "result", text: last.content };
  }
  const halted = events.find((e) => e.type === "assistant.halted");
  if (halted && halted.type === "assistant.halted") {
    return { kind: "halted", reason: halted.reason };
  }
  const errs = snapshot.errors;
  if (errs.length > 0) {
    const latest = errs[errs.length - 1];
    const message =
      latest.error instanceof Error ? latest.error.message : String(latest.error);
    return { kind: "error", message: `${latest.phase}: ${message}` };
  }
  return null;
};
