import fc from "fast-check";
import { Chunk } from "effect";
import { describe, expect, it } from "vitest";
import { isHalted } from "@flamecast/agentjsx/projections";
import type { Event } from "@flamecast/agentjsx/types";
import type { EventInput } from "@flamecast/agentjsx/event-log";

// Algebraic property test for `isHalted` — the per-turn halt semantics
// (projections.ts:165-181). The behavior is "scan from the end; the
// first terminal marker (user.message OR assistant.halted) wins."
//
// Laws:
//   H1. Empty log is not halted.
//   H2. After `user.message`, halt is reset regardless of prior halts.
//       i.e. for any prefix L, isHalted(L ++ [..., user.message]) = false.
//   H3. After `assistant.halted` (with no later user.message), halted = true.
//   H4. The only events that flip the result are `user.message` and
//       `assistant.halted`. Inserting any other event AFTER the most
//       recent terminal marker doesn't change `isHalted`.
//
// Without H2, halt is absorbing across turns and the interactive REPL
// dies after the first maxSteps-trigger or model-driven halt — the
// load-bearing motivation for the per-turn semantic, surfaced live in
// the previous session.

const NUM_RUNS = 100;

const eventArb: fc.Arbitrary<EventInput> = fc.oneof(
  fc.string({ maxLength: 4 }).map(
    (content): EventInput => ({ type: "user.message", content }),
  ),
  fc.string({ maxLength: 4 }).map(
    (content): EventInput => ({ type: "assistant.message", content }),
  ),
  fc.constant<EventInput>({ type: "assistant.halted", reason: "test" }),
  fc.string({ minLength: 1, maxLength: 4 }).map(
    (id): EventInput => ({
      type: "tool.call.started",
      tool_call_id: id,
      tool_name: "x",
    }),
  ),
  fc.string({ minLength: 1, maxLength: 4 }).map(
    (id): EventInput => ({
      type: "tool.result",
      tool_call_id: id,
      content: "r",
    }),
  ),
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
      case "todo.added":
        return { seq: i, type: "todo.added", text: s.text };
      case "todo.completed":
        return { seq: i, type: "todo.completed", index: s.index };
    }
  });

// Reference reimplementation. The point of property tests against a
// reference is to prove the production matches the spec independently
// stated; if both have the same bug, the property still passes — we
// also use the laws (H1-H4) to constrain the spec itself.
const referenceIsHalted = (events: ReadonlyArray<Event>): boolean => {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "user.message") return false;
    if (e.type === "assistant.halted") return true;
  }
  return false;
};

describe("halt semantics: per-turn, not absorbing", () => {
  it("H1 — empty log is not halted", () => {
    expect(isHalted(Chunk.empty<Event>())).toBe(false);
  });

  it("H2 — appending a user.message ALWAYS resets halt to false", () => {
    fc.assert(
      fc.property(fc.array(eventArb, { minLength: 0, maxLength: 12 }), (shapes) => {
        const log = buildLog([...shapes, { type: "user.message", content: "u" }]);
        expect(isHalted(Chunk.fromIterable(log))).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("H3 — appending assistant.halted (with no later user.message) yields halted=true", () => {
    fc.assert(
      fc.property(
        fc.array(eventArb, { minLength: 0, maxLength: 8 }),
        // Tail events that are NOT user.message and NOT assistant.halted.
        // Includes compaction.summary so a future regression that
        // accidentally special-cases a new event type would fail this
        // property instead of silently passing.
        fc.array(
          fc.oneof(
            fc.string({ maxLength: 4 }).map(
              (content): EventInput => ({
                type: "assistant.message",
                content,
              }),
            ),
            fc.string({ minLength: 1, maxLength: 4 }).map(
              (id): EventInput => ({
                type: "tool.call.started",
                tool_call_id: id,
                tool_name: "x",
              }),
            ),
            fc.string({ minLength: 1, maxLength: 4 }).map(
              (id): EventInput => ({
                type: "tool.result",
                tool_call_id: id,
                content: "r",
              }),
            ),
            fc.string({ maxLength: 4 }).map(
              (text): EventInput => ({
                type: "compaction.summary",
                fromSeq: 0,
                toSeq: 0,
                text,
              }),
            ),
          ),
          { minLength: 0, maxLength: 4 },
        ),
        (prefix, tail) => {
          const log = buildLog([
            ...prefix,
            { type: "assistant.halted", reason: "x" },
            ...tail,
          ]);
          expect(isHalted(Chunk.fromIterable(log))).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("H4 — matches the reference implementation on arbitrary logs", () => {
    fc.assert(
      fc.property(fc.array(eventArb, { minLength: 0, maxLength: 16 }), (shapes) => {
        const log = buildLog(shapes);
        expect(isHalted(Chunk.fromIterable(log))).toBe(referenceIsHalted(log));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
