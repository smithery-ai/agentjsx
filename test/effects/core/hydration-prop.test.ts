import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { reconcileHydrationDangling } from "@flamecast/agentctx/hydration";
import type { Event, ToolCall } from "@flamecast/agentctx/types";

// Algebraic property test for `reconcileHydrationDangling`. Proves the
// structural laws hydration must satisfy:
//
//   L1. Prefix preservation: reconcile(L)[0..L.length] === L verbatim.
//   L2. Idempotence:        reconcile(reconcile(L)) === reconcile(L).
//   L3. Seq density:        the output's seqs are exactly 0..N-1.
//   L4. Sound dangling set: every appended synthetic result corresponds
//                          to a dangling beacon or unresolved tool_call,
//                          and every dangling id appears exactly once.
//   L5. Already-resolved no-op: if no tool_calls or beacons are dangling,
//                          reconcile is the identity function.
//
// These together encode "hydration is identity modulo synthetic markers
// for dangling work" — the load-bearing claim behind crash-resume and
// the EventLog seed (`event-log.ts:43`).

const NUM_RUNS = 100;

// Generators ---------------------------------------------------------------

const idArb = fc.string({ minLength: 1, maxLength: 4 }).map((s) => `id-${s}`);
const nameArb = fc.constantFrom("a", "b", "c");

const toolCallsArb = fc
  .array(
    fc.record({ id: idArb, name: nameArb }).map(
      ({ id, name }): ToolCall => ({
        id,
        type: "function",
        function: { name, arguments: "{}" },
      }),
    ),
    { minLength: 1, maxLength: 3 },
  )
  // Dedup by id within one assistant message — the runtime guarantees this.
  .map((tcs) => {
    const seen = new Set<string>();
    return tcs.filter((tc) => {
      if (seen.has(tc.id)) return false;
      seen.add(tc.id);
      return true;
    });
  });

// An "event shape" without seq. We assign seqs after the array is built so
// the input log honors the seq=index invariant the reconciler relies on.
type EventShape =
  | { kind: "user" }
  | { kind: "assistant"; toolCalls?: ToolCall[] }
  | { kind: "started"; id: string; name: string }
  | { kind: "result"; id: string };

const eventShapeArb = fc.oneof(
  fc.constant<EventShape>({ kind: "user" }),
  toolCallsArb.map((tcs): EventShape => ({ kind: "assistant", toolCalls: tcs })),
  fc.constant<EventShape>({ kind: "assistant" }),
  fc
    .record({ id: idArb, name: nameArb })
    .map(({ id, name }): EventShape => ({ kind: "started", id, name })),
  idArb.map((id): EventShape => ({ kind: "result", id })),
);

const buildLog = (shapes: EventShape[]): Event[] => {
  const out: Event[] = [];
  shapes.forEach((s, i) => {
    const seq = i;
    switch (s.kind) {
      case "user":
        out.push({ seq, type: "user.message", content: "u" });
        break;
      case "assistant":
        out.push({
          seq,
          type: "assistant.message",
          content: "a",
          ...(s.toolCalls && s.toolCalls.length > 0
            ? { tool_calls: s.toolCalls }
            : {}),
        });
        break;
      case "started":
        out.push({
          seq,
          type: "tool.call.started",
          tool_call_id: s.id,
          tool_name: s.name,
        });
        break;
      case "result":
        out.push({
          seq,
          type: "tool.result",
          tool_call_id: s.id,
          content: "r",
        });
        break;
    }
  });
  return out;
};

// Bias towards generating dangling work: shapes can include beacons + assistant
// tool_calls without matching results. We don't actively suppress matches —
// the generator can also produce already-resolved logs, exercising L5.
const logArb = fc
  .array(eventShapeArb, { minLength: 0, maxLength: 12 })
  .map(buildLog);

// Reference implementation of "what should be dangling" — kept independent
// of the production code so a bug in production doesn't silently get
// validated by a copy of itself.
const referenceDangling = (events: readonly Event[]): string[] => {
  const resulted = new Set<string>();
  for (const e of events) if (e.type === "tool.result") resulted.add(e.tool_call_id);

  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (e.type === "assistant.message" && e.tool_calls) {
      for (const tc of e.tool_calls) {
        if (!resulted.has(tc.id) && !seen.has(tc.id)) {
          out.push(tc.id);
          seen.add(tc.id);
        }
      }
    }
    if (e.type === "tool.call.started") {
      if (!resulted.has(e.tool_call_id) && !seen.has(e.tool_call_id)) {
        out.push(e.tool_call_id);
        seen.add(e.tool_call_id);
      }
    }
  }
  return out;
};

describe("hydration: algebraic laws", () => {
  it("L1 — prefix preservation: reconcile(L) starts with L verbatim", () => {
    fc.assert(
      fc.property(logArb, (log) => {
        const out = reconcileHydrationDangling(log);
        expect(out.length).toBeGreaterThanOrEqual(log.length);
        for (let i = 0; i < log.length; i++) {
          expect(out[i]).toEqual(log[i]);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("L2 — idempotence: reconcile is fixed-point after one pass", () => {
    fc.assert(
      fc.property(logArb, (log) => {
        const once = reconcileHydrationDangling(log);
        const twice = reconcileHydrationDangling(once);
        expect(twice).toEqual(once);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("L3 — seq density: output seqs are 0..N-1, dense and contiguous", () => {
    fc.assert(
      fc.property(logArb, (log) => {
        const out = reconcileHydrationDangling(log);
        out.forEach((e, i) => expect(e.seq).toBe(i));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("L4 — sound dangling set: appended synthetic results bijection-match the dangling ids", () => {
    fc.assert(
      fc.property(logArb, (log) => {
        const out = reconcileHydrationDangling(log);
        const expected = referenceDangling(log);
        const appended = out.slice(log.length);
        expect(appended.length).toBe(expected.length);
        const appendedIds = appended.map((e) => {
          expect(e.type).toBe("tool.result");
          // narrowing
          if (e.type !== "tool.result") throw new Error("unreachable");
          expect(e.content).toContain("interrupted");
          return e.tool_call_id;
        });
        // Order within the appended block matches reference order — this
        // pins the reconciler's traversal semantics so future refactors
        // can't silently change crash-resume behavior.
        expect(appendedIds).toEqual(expected);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("L5 — no-op on already-resolved logs: if every tool_call has a result, reconcile is identity (modulo array copy)", () => {
    // `fc.pre` surfaces filtered cases in fast-check's stats instead of
    // silently early-returning — we actually want visibility into how
    // many runs asserted something, since the precondition is restrictive.
    fc.assert(
      fc.property(logArb, (log) => {
        fc.pre(referenceDangling(log).length === 0);
        const out = reconcileHydrationDangling(log);
        expect(out).toEqual(log);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
