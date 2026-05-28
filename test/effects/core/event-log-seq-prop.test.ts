import fc from "fast-check";
import { Chunk, Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeEventLog } from "@flamecast/agentctx/event-log";
import type { EventInput } from "@flamecast/agentctx/event-log";

// Algebraic property test for `EventLog`'s seq monotonicity contract:
//
//   M1. After appending exactly N events (single or in batches),
//       `Chunk.size(snapshot) === N` and `events[i].seq === i`.
//   M2. Concurrency safety: when many fibers race `append`/`appendMany`,
//       the resulting log still has dense, contiguous seqs 0..N-1 with
//       no collisions and no skips. The total count equals the sum of
//       batch sizes that were issued.
//
// `event-log.ts` lines 14-17 declare the contract: "Every appended event's
// seq equals its zero-based index in the resulting Chunk — which is the
// invariant the hydration reconciler relies on." This file proves it under
// adversarial interleaving — which `event-log.test.ts` does not exercise.

const NUM_RUNS = 30;

const eventInputArb: fc.Arbitrary<EventInput> = fc.oneof(
  fc
    .string({ minLength: 0, maxLength: 4 })
    .map((content): EventInput => ({ type: "user.message", content })),
  fc
    .string({ minLength: 0, maxLength: 4 })
    .map((content): EventInput => ({ type: "assistant.message", content })),
);

// A "write op" is either a single append or a batched appendMany of 1..3 items.
type Op = { kind: "single"; e: EventInput } | { kind: "batch"; es: EventInput[] };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  eventInputArb.map((e): Op => ({ kind: "single", e })),
  fc
    .array(eventInputArb, { minLength: 1, maxLength: 3 })
    .map((es): Op => ({ kind: "batch", es })),
);

describe("event-log: seq density laws", () => {
  it("M1 — sequential writes produce dense seqs 0..N-1 and Chunk.size === N", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 0, maxLength: 20 }), async (ops) => {
        const expectedTotal = ops.reduce(
          (n, o) => n + (o.kind === "single" ? 1 : o.es.length),
          0,
        );
        const program = Effect.gen(function* () {
          const log = yield* makeEventLog();
          for (const op of ops) {
            if (op.kind === "single") yield* log.append(op.e);
            else yield* log.appendMany(op.es);
          }
          return yield* log.snapshot;
        });
        const chunk = await Effect.runPromise(program);
        const arr = Chunk.toReadonlyArray(chunk);
        expect(arr.length).toBe(expectedTotal);
        arr.forEach((e, i) => expect(e.seq).toBe(i));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("M2 — concurrent writers produce dense seqs with no collisions or skips", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Several fiber-shaped "writers", each issuing several ops. Total
        // ops bounded so wall time stays modest under the runner.
        fc.array(fc.array(opArb, { minLength: 1, maxLength: 4 }), {
          minLength: 2,
          maxLength: 5,
        }),
        async (writers) => {
          const expectedTotal = writers
            .flat()
            .reduce((n, o) => n + (o.kind === "single" ? 1 : o.es.length), 0);

          const program = Effect.gen(function* () {
            const log = yield* makeEventLog();
            // Fork each writer concurrently. SubscriptionRef.modify is
            // atomic per-call; the property under test is that the
            // resulting seqs are still dense even under interleaving.
            const fibers = yield* Effect.forEach(
              writers,
              (ops) =>
                Effect.fork(
                  Effect.gen(function* () {
                    for (const op of ops) {
                      if (op.kind === "single") yield* log.append(op.e);
                      else yield* log.appendMany(op.es);
                    }
                  }),
                ),
              { concurrency: "unbounded" },
            );
            for (const f of fibers) yield* f.await;
            return yield* log.snapshot;
          });

          const chunk = await Effect.runPromise(program);
          const arr = Chunk.toReadonlyArray(chunk);
          expect(arr.length).toBe(expectedTotal);
          // Density: every seq from 0..N-1 appears exactly once.
          const seqs = arr.map((e) => e.seq).sort((a, b) => a - b);
          for (let i = 0; i < seqs.length; i++) {
            expect(seqs[i]).toBe(i);
          }
          // Position equals seq (the chunk is the canonical ordering).
          arr.forEach((e, i) => expect(e.seq).toBe(i));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("M2b — batched appends are atomic: a single appendMany([a,b,c]) produces three contiguous seqs not interleaved with other writers", async () => {
    // Stronger: even under contention, an appendMany batch occupies a
    // contiguous slice. This pins the claim that appendMany is "one
    // SynchronizedRef.modify" rather than "N appends in a loop".
    //
    // Per-writer tag must be unique within the property — we assign a
    // positional prefix so `fc.array`-generated tags can collide freely
    // but still distinguish writers for the contiguity check.
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.integer({ min: 2, max: 4 }).map((size) => ({ size })),
          { minLength: 2, maxLength: 5 },
        ),
        async (rawWriters) => {
          const writers = rawWriters.map((w, i) => ({
            tag: `w${i}`,
            size: w.size,
          }));
          const program = Effect.gen(function* () {
            const log = yield* makeEventLog();
            const fibers = yield* Effect.forEach(
              writers,
              (w) =>
                Effect.fork(
                  log.appendMany(
                    Array.from({ length: w.size }, (_, i) => ({
                      type: "user.message" as const,
                      content: `${w.tag}:${i}`,
                    })),
                  ),
                ),
              { concurrency: "unbounded" },
            );
            for (const f of fibers) yield* f.await;
            return yield* log.snapshot;
          });
          const arr = Chunk.toReadonlyArray(await Effect.runPromise(program));
          // For each writer's tag, the indices where that tag appears
          // must be a contiguous range — proving atomicity.
          for (const w of writers) {
            const indices: number[] = [];
            arr.forEach((e, i) => {
              if (
                e.type === "user.message" &&
                typeof e.content === "string" &&
                e.content.startsWith(`${w.tag}:`)
              ) {
                indices.push(i);
              }
            });
            expect(indices.length).toBe(w.size);
            for (let i = 1; i < indices.length; i++) {
              expect(indices[i]).toBe(indices[i - 1]! + 1);
            }
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
