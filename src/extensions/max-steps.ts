import { Chunk, Effect, Layer, Stream } from "effect";
import { AgentCtx } from "../core/agent-ctx";
import type { Extension } from "../core/agent";
import { isHalted } from "../core/projections";

// Halt after N assistant messages. Watches the event log; when the
// count of `assistant.message` events reaches `limit` AND the log is
// not already halted, appends an `assistant.halted` event.
//
// Counting is over `assistant.message` only (not `tool.call.started`,
// not `tool.result`, not halt markers). The halt fires on the Nth
// message — i.e. the Nth assistant.message triggers the halt, so the
// agent's next inference will see the halt and skip.
//
// Idempotent: if the seeded log already contains `assistant.halted`,
// this layer is a no-op. If it already has ≥ N assistant messages but
// no halt, we append one exactly once — `Stream.changesWith` on the
// "should halt" predicate collapses repeated fires.
export const maxSteps = (limit: number): Extension =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const ctx = yield* AgentCtx;

      const step = Effect.gen(function* () {
        const events = yield* ctx.events.snapshot;
        if (isHalted(events)) return;
        // Count assistant.messages SINCE the most recent user.message.
        // Halt is per-turn (see `isHalted`), so the cap must also be
        // per-turn — otherwise every new user turn would re-halt
        // immediately on the lifetime count.
        const arr = Chunk.toReadonlyArray(events);
        let assistantTurns = 0;
        for (let i = arr.length - 1; i >= 0; i--) {
          const e = arr[i];
          if (e.type === "user.message") break;
          if (e.type === "assistant.message") assistantTurns++;
        }
        if (assistantTurns < limit) return;
        yield* ctx.events.append({
          type: "assistant.halted",
          reason: `Agent loop reached maximum steps (${limit}).`,
        });
      });

      const driver = ctx.events.changes.pipe(
        Stream.changesWith((a, b) => Chunk.size(a) === Chunk.size(b)),
        Stream.mapEffect(() => step, { concurrency: 1 }),
      );

      yield* Effect.forkScoped(Stream.runDrain(driver));
    }),
  );
