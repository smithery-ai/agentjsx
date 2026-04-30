import { Chunk, Effect, type Fiber, Runtime, type Scope, Stream } from "effect";
import { AgentCtx } from "./agent-ctx";
import { InferenceError } from "./errors";
import { isHalted, toolsInFlight } from "./projections";
import type { Event, InferFn, InferOptions } from "./types";

// Inference loop. Subscribes to the event log; for every new log state
// where the last event is `user.message` or `tool.result` AND the log
// is neither halted nor waiting on in-flight tools, calls `infer` and
// appends the assistant response. Concurrency is strictly 1: a single
// inference batch runs at a time so the LLM's reply can never race an
// overlapping reply from a re-entrant trigger.
//
// Re-checks `isHalted` AFTER the infer promise resolves. If a halt
// landed while infer was awaiting, the response is dropped — the log
// must reflect the halt as the final state. See signals/graph.ts:321-322.
export const runInference = (
  infer: InferFn,
): Effect.Effect<Fiber.RuntimeFiber<void, never>, never, AgentCtx | Scope.Scope> =>
  Effect.gen(function* () {
    const ctx = yield* AgentCtx;

    const step = (events: Chunk.Chunk<Event>): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (isHalted(events)) return;
        const last = Chunk.last(events);
        if (last._tag === "None") return;
        const type = last.value.type;
        if (type !== "user.message" && type !== "tool.result") return;
        if (toolsInFlight(events)) return;

        // Render the ProviderContext inline from primary sources rather
        // than reading `ctx.rendered`. The materialized `rendered` ref
        // is maintained by a forked render fiber also subscribed to
        // `events.changes`; when the events emit, both fibers are
        // notified concurrently with no ordering guarantee, so reading
        // `ctx.rendered` here can (and does) return the PRE-append
        // snapshot. Result: inference fires on the new events state
        // but with stale history, producing a reply that belongs to
        // the previous turn. See test/agentctx/core/
        // inference-consistency.test.ts for the failure mode.
        const context = yield* ctx.render;

        const runtime = yield* Effect.runtime<never>();
        const runFork = Runtime.runFork(runtime);
        const turnId = crypto.randomUUID();
        const opts: InferOptions = {
          onDelta: (text) => { runFork(ctx.emitTextDelta({ turnId, text })); },
        };

        const response = yield* Effect.tryPromise({
          try: () => infer(context, opts),
          catch: (cause) => new InferenceError({ cause }),
        });

        // Re-check halt after the async boundary. Without this, a halt
        // extension that fires during `await infer()` would be racing
        // the append and leave the log with an `assistant.halted`
        // followed by a stray `assistant.message`.
        const current = yield* ctx.events.snapshot;
        if (isHalted(current)) return;

        yield* ctx.events.append({
          type: "assistant.message",
          content: response.content,
          tool_calls: response.tool_calls,
        });
      }).pipe(
        Effect.catchAll((err) =>
          // Two-channel surfacing. The structured error still lands on
          // `ctx.errors` for backwards compat, AND the failure is
          // appended to the event log as a terminal event so
          // `agent.until` / projections / hydration replay all see it.
          // Without the event-log append, an InferFn that throws becomes
          // a stuck-`running` session: the predicate never gets a
          // terminal-shaped event to match on, no `assistant.halted`
          // lands, and the public state is indistinguishable from "still
          // thinking". This is a real silent-hang failure mode every
          // integrator currently has to work around.
          Effect.gen(function* () {
            const cause =
              err instanceof Error ? err.message : String(err);
            yield* ctx.events.append({
              type: "inference.failed",
              cause,
              phase: "inference",
            });
            yield* ctx.reportError("inference", err);
          }),
        ),
      );

    const driver = ctx.events.changes.pipe(
      Stream.mapEffect(step, { concurrency: 1 }),
    );

    return yield* Effect.forkScoped(Stream.runDrain(driver));
  });
