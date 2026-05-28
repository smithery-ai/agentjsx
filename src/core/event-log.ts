import { Chunk, Effect, Stream, SubscriptionRef } from "effect";
import { reconcileHydrationDangling } from "./hydration";
import type { Event } from "./types";

// EventLog is the append-only source of truth for an agent. It wraps a
// `SubscriptionRef<Chunk<Event>>` so consumers can:
//   - read the current log synchronously within an Effect (`snapshot`)
//   - subscribe to changes as a Stream that replays the current value on
//     subscribe (`changes`) — critical for the inference fiber so it never
//     "misses the edge" on a log that's already in a trigger-ready state
//   - append atomically (`append`, `appendMany`) via the underlying
//     SynchronizedRef semantics
//
// `seq` is assigned here, not by the caller. The caller describes the event
// shape; EventLog owns monotonicity. Every appended event's `seq` equals its
// zero-based index in the resulting Chunk — which is the invariant the
// hydration reconciler relies on.

// Distributive "event minus seq". `Omit<Event, "seq">` does NOT distribute
// over the union members (TS collapses the intersection first), so an
// object literal like `{ type: "assistant.message", content: "..." }`
// fails excess-property checks against it. The distributive form below
// preserves each union member's own keyset so callers can write naked
// event literals without `as`-casts.
export type EventInput = Event extends infer E
  ? E extends { seq: number }
    ? Omit<E, "seq">
    : never
  : never;

export interface EventLog {
  readonly snapshot: Effect.Effect<Chunk.Chunk<Event>>;
  readonly changes: Stream.Stream<Chunk.Chunk<Event>>;
  readonly append: (event: EventInput) => Effect.Effect<Event>;
  readonly appendMany: (
    events: ReadonlyArray<EventInput>,
  ) => Effect.Effect<ReadonlyArray<Event>>;
}

// Build an EventLog seeded with `initialEvents`. The seed is passed through
// `reconcileHydrationDangling` so a crashed-mid-tool log is advanced with
// synthetic `[interrupted]` markers before any consumer observes it.
export const makeEventLog = (
  initialEvents: ReadonlyArray<Event> = [],
): Effect.Effect<EventLog> =>
  Effect.gen(function* () {
    const reconciled = reconcileHydrationDangling(initialEvents);
    const ref = yield* SubscriptionRef.make(Chunk.fromIterable(reconciled));

    const append: EventLog["append"] = (data) =>
      SubscriptionRef.modify(ref, (current) => {
        const seq = Chunk.size(current);
        const event = { ...data, seq } as Event;
        return [event, Chunk.append(current, event)] as const;
      });

    const appendMany: EventLog["appendMany"] = (datas) =>
      SubscriptionRef.modify(ref, (current) => {
        let next = current;
        const appended: Event[] = [];
        for (const d of datas) {
          const event = { ...d, seq: Chunk.size(next) } as Event;
          appended.push(event);
          next = Chunk.append(next, event);
        }
        return [appended as ReadonlyArray<Event>, next] as const;
      });

    return {
      snapshot: SubscriptionRef.get(ref),
      changes: ref.changes,
      append,
      appendMany,
    };
  });
