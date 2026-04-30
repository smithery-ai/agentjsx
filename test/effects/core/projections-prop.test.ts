import fc from "fast-check";
import { Chunk } from "effect";
import { describe, expect, it } from "vitest";
import {
  lastResult,
  pendingToolCallsFromLog,
  renderHistoryFragments,
  toolsInFlight,
} from "effectctx/projections";
import type { EventInput } from "effectctx/event-log";
import type { Event, ToolCall } from "effectctx/types";

// Algebraic property tests for the pure projections in
// `src/effects/projections.ts`. These functions sit on the hot path of
// every projection cycle; they are referentially transparent and have
// well-defined laws that should hold over arbitrary logs.
//
// Coverage:
//   P1. renderHistoryFragments DROPS tool.call.started (intent beacons are
//       internal, never visible to LLM).
//   P2. renderHistoryFragments COLLAPSES a compaction boundary covering
//       [lo, hi] into exactly ONE system block at the position of the
//       lowest covered seq, hiding all events in [lo, hi].
//   P3. renderHistoryFragments PRESERVES eventSeq on every emitted block
//       so transforms and `truncateToolOutputs` can reference the source.
//   PT1. pendingToolCallsFromLog returns empty when no assistant.message
//        with tool_calls exists, OR when all calls have results.
//   PT2. pendingToolCallsFromLog reads the MOST RECENT assistant.message
//        with tool_calls — non-assistant tail events (halted, tool.result)
//        do not hide it.
//   PT3. pendingToolCallsFromLog NEVER returns ids that have a tool.result.
//   LR1. lastResult is non-null IFF the very last event is an
//        assistant.message with no unresolved tool_calls.
//   TF1. toolsInFlight is true IFF some tool.call.started lacks a
//        matching tool.result.

const NUM_RUNS = 100;

// Generators ---------------------------------------------------------------

const idArb = fc.string({ minLength: 1, maxLength: 4 }).map((s) => `id-${s}`);

const tcArb: fc.Arbitrary<ToolCall> = idArb.map((id) => ({
  id,
  type: "function" as const,
  function: { name: "x", arguments: "{}" },
}));

const eventInputArb: fc.Arbitrary<EventInput> = fc.oneof(
  fc
    .string({ maxLength: 4 })
    .map((c): EventInput => ({ type: "user.message", content: c })),
  fc.tuple(fc.string({ maxLength: 4 }), fc.array(tcArb, { maxLength: 3 })).map(
    ([content, tcs]): EventInput =>
      tcs.length > 0
        ? { type: "assistant.message", content, tool_calls: tcs }
        : { type: "assistant.message", content },
  ),
  idArb.map(
    (id): EventInput => ({
      type: "tool.call.started",
      tool_call_id: id,
      tool_name: "x",
    }),
  ),
  idArb.map(
    (id): EventInput => ({
      type: "tool.result",
      tool_call_id: id,
      content: "r",
    }),
  ),
  fc.constant<EventInput>({ type: "assistant.halted", reason: "x" }),
);

// Union-safe seq assignment. Avoids `as Event` (forbidden by repo
// CLAUDE.md outside generic boundaries) by rebuilding the event per
// discriminant. Adding a new Event member surfaces as a missing case.
const buildLog = (shapes: ReadonlyArray<EventInput>): Event[] =>
  shapes.map((s, i): Event => {
    switch (s.type) {
      case "user.message":
        return { seq: i, type: "user.message", content: s.content };
      case "assistant.message":
        return s.tool_calls
          ? { seq: i, type: "assistant.message", content: s.content, tool_calls: s.tool_calls }
          : { seq: i, type: "assistant.message", content: s.content };
      case "tool.call.started":
        return {
          seq: i,
          type: "tool.call.started",
          tool_call_id: s.tool_call_id,
          tool_name: s.tool_name,
        };
      case "tool.result":
        return {
          seq: i,
          type: "tool.result",
          tool_call_id: s.tool_call_id,
          content: s.content,
        };
      case "assistant.halted":
        return { seq: i, type: "assistant.halted", reason: s.reason };
      case "inference.failed":
        return {
          seq: i,
          type: "inference.failed",
          cause: s.cause,
          phase: s.phase,
        };
      case "compaction.summary":
        return s.prompt !== undefined
          ? {
              seq: i,
              type: "compaction.summary",
              fromSeq: s.fromSeq,
              toSeq: s.toSeq,
              text: s.text,
              prompt: s.prompt,
            }
          : {
              seq: i,
              type: "compaction.summary",
              fromSeq: s.fromSeq,
              toSeq: s.toSeq,
              text: s.text,
            };
    }
  });

const logArb = fc
  .array(eventInputArb, { minLength: 0, maxLength: 16 })
  .map((s) => Chunk.fromIterable(buildLog(s)));

describe("projections: renderHistoryFragments laws", () => {
  it("P1 — every tool.call.started is dropped from the projection", () => {
    fc.assert(
      fc.property(logArb, (chunk) => {
        const blocks = renderHistoryFragments(chunk);
        // No projected block has the seq of any beacon event.
        const beaconSeqs = new Set(
          Chunk.toReadonlyArray(chunk)
            .filter((e) => e.type === "tool.call.started")
            .map((e) => e.seq),
        );
        for (const b of blocks) {
          if ("eventSeq" in b) {
            expect(beaconSeqs.has(b.eventSeq)).toBe(false);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("P2 — a compaction.summary covering [lo, hi] collapses the range into exactly one system block", () => {
    fc.assert(
      fc.property(
        // Build a base log of length N, pick a covered range, then append
        // a compaction.summary for that range. The summary itself
        // doesn't appear inline; the system block does.
        fc.array(eventInputArb, { minLength: 4, maxLength: 12 }),
        fc.integer({ min: 0 }),
        fc.integer({ min: 0 }),
        (base, lo01, hi01) => {
          const N = base.length;
          if (N < 2) return;
          const lo = lo01 % N;
          const hi = lo + (hi01 % (N - lo));
          const events = buildLog(base);
          const summary: Event = {
            seq: events.length,
            type: "compaction.summary",
            fromSeq: lo,
            toSeq: hi,
            text: "S",
          };
          const chunk = Chunk.fromIterable([...events, summary]);
          const blocks = renderHistoryFragments(chunk);
          // Exactly one system block with source "compaction".
          const compactionBlocks = blocks.filter((b) => b.source === "compaction");
          expect(compactionBlocks.length).toBe(1);
          expect(compactionBlocks[0]!.tag).toBe("core/compaction-summary");
          expect(compactionBlocks[0]!.content).toContain("S");
          // No history block has eventSeq within [lo, hi].
          for (const b of blocks) {
            if (b.source !== "history") continue;
            if (!("eventSeq" in b)) continue;
            const inRange = b.eventSeq >= lo && b.eventSeq <= hi;
            expect(inRange, `seq ${b.eventSeq} should be hidden by [${lo},${hi}]`).toBe(false);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("P3 — every history block has an eventSeq that points to a real event in the log", () => {
    fc.assert(
      fc.property(logArb, (chunk) => {
        const blocks = renderHistoryFragments(chunk);
        const validSeqs = new Set(
          Chunk.toReadonlyArray(chunk).map((e) => e.seq),
        );
        for (const b of blocks) {
          if (b.source === "history") {
            // Every history-derived variant carries eventSeq (the one
            // exception — core/system — is never emitted by history).
            expect("eventSeq" in b).toBe(true);
            if ("eventSeq" in b) {
              expect(validSeqs.has(b.eventSeq)).toBe(true);
            }
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("projections: pendingToolCallsFromLog laws", () => {
  it("PT1 — empty when no assistant.message carries tool_calls (halt + beacons must not short-circuit)", () => {
    // Arbitrary EXCLUDES `assistant.message` with tool_calls (the only
    // event type that can contribute pending calls), but INCLUDES halt
    // and beacon events so a regression where `pendingToolCallsFromLog`
    // incorrectly special-cases those is caught.
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.string({ maxLength: 4 }).map(
              (c): EventInput => ({ type: "user.message", content: c }),
            ),
            fc.string({ maxLength: 4 }).map(
              (c): EventInput => ({ type: "assistant.message", content: c }),
            ),
            idArb.map(
              (id): EventInput => ({
                type: "tool.result",
                tool_call_id: id,
                content: "r",
              }),
            ),
            idArb.map(
              (id): EventInput => ({
                type: "tool.call.started",
                tool_call_id: id,
                tool_name: "x",
              }),
            ),
            fc.constant<EventInput>({ type: "assistant.halted", reason: "x" }),
          ),
          { minLength: 0, maxLength: 12 },
        ),
        (shapes) => {
          const chunk = Chunk.fromIterable(buildLog(shapes));
          expect(pendingToolCallsFromLog(chunk)).toEqual([]);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("PT2 — non-assistant tail events do not hide the most recent tool_call batch", () => {
    fc.assert(
      fc.property(
        fc.array(eventInputArb, { minLength: 0, maxLength: 6 }),
        fc.array(tcArb, { minLength: 1, maxLength: 3 }),
        // Only halt / tool.result allowed in tail — anything that is NOT
        // an assistant.message. user.message would resume normally; the
        // batch returned should still be the latest one.
        fc.array(
          fc.oneof(
            fc.constant<EventInput>({ type: "assistant.halted", reason: "x" }),
            idArb.map(
              (id): EventInput => ({
                type: "tool.result",
                tool_call_id: id,
                content: "r",
              }),
            ),
            idArb.map(
              (id): EventInput => ({
                type: "tool.call.started",
                tool_call_id: id,
                tool_name: "x",
              }),
            ),
          ),
          { minLength: 0, maxLength: 4 },
        ),
        (prefix, batch, tail) => {
          const shapes: EventInput[] = [
            ...prefix,
            { type: "assistant.message", content: "", tool_calls: batch },
            ...tail,
          ];
          const events = buildLog(shapes);
          const chunk = Chunk.fromIterable(events);
          const result = pendingToolCallsFromLog(chunk);
          // Every id in the batch that doesn't have a tool.result in
          // `tail` (or anywhere) is returned.
          const resulted = new Set(
            events.filter((e) => e.type === "tool.result").map((e) => {
              if (e.type !== "tool.result") throw new Error("unreachable");
              return e.tool_call_id;
            }),
          );
          const expected = batch.filter((tc) => !resulted.has(tc.id));
          expect(result).toEqual(expected);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("PT3 — never returns an id that has a tool.result anywhere in the log", () => {
    fc.assert(
      fc.property(logArb, (chunk) => {
        const arr = Chunk.toReadonlyArray(chunk);
        const resulted = new Set(
          arr
            .filter((e) => e.type === "tool.result")
            .map((e) => {
              if (e.type !== "tool.result") throw new Error("unreachable");
              return e.tool_call_id;
            }),
        );
        const pending = pendingToolCallsFromLog(chunk);
        for (const tc of pending) {
          expect(resulted.has(tc.id)).toBe(false);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("projections: lastResult + toolsInFlight laws", () => {
  it("LR1 — lastResult non-null IFF the final event is an assistant.message with no unresolved tool_calls", () => {
    fc.assert(
      fc.property(logArb, (chunk) => {
        const arr = Chunk.toReadonlyArray(chunk);
        const last = arr[arr.length - 1];
        const result = lastResult(chunk);
        if (
          last &&
          last.type === "assistant.message" &&
          (!last.tool_calls || last.tool_calls.length === 0)
        ) {
          expect(result).toBe(last);
        } else {
          expect(result).toBe(null);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("TF1 — toolsInFlight true IFF some tool.call.started has no matching tool.result", () => {
    fc.assert(
      fc.property(logArb, (chunk) => {
        const arr = Chunk.toReadonlyArray(chunk);
        const resulted = new Set(
          arr
            .filter((e) => e.type === "tool.result")
            .map((e) => {
              if (e.type !== "tool.result") throw new Error("unreachable");
              return e.tool_call_id;
            }),
        );
        const expected = arr.some(
          (e) => e.type === "tool.call.started" && !resulted.has(e.tool_call_id),
        );
        expect(toolsInFlight(chunk)).toBe(expected);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
