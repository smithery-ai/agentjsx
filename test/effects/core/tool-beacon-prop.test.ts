import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createAgentRuntime, defineTool } from "@flamecast/agentjsx";
import type { InferFn, InferResponse, ToolCall } from "@flamecast/agentjsx";
import { Schema } from "effect";

// Algebraic property test for the tool-execution protocol
// (CLAUDE.md principle 1 + tool-exec.ts invariants 2, 4, 5).
//
// Laws:
//   B1. Beacon precedes result: for every (tool_call_id X), the
//       `tool.call.started` event with id=X appears at a STRICTLY LOWER
//       seq than the matching `tool.result` with id=X.
//   B2. Exactly-one beacon and exactly-one result per tool call: the
//       log contains one beacon and one result per id the assistant
//       asked for. No duplicates, no orphans (modulo halt-in-flight).
//   B3. Intent batch atomicity: the beacons for one tool-call batch
//       occupy contiguous seqs, all strictly less than any of the
//       batch's results' seqs. This pins the "beacons first, results
//       second, in two atomic appendMany batches" contract.
//
// These together encode "the framework writes the log; no tool output
// can exist without a prior beacon." Hydration correctness depends on
// this: see hydration.ts:5-7 (a beacon without a matching result is
// exactly how crash-mid-tool is detected).

const NUM_RUNS = 20;

// A synthetic tool schedule: the inference function, on its k-th call,
// returns N tool calls with distinct ids. The runtime should execute
// them and the resulting log must satisfy B1/B2/B3 regardless of how
// many concurrent calls are in a batch.

type Plan = {
  // Per-turn: how many tool calls the assistant issues. Empty array
  // means the turn returns plain content and we move on.
  readonly turns: ReadonlyArray<ReadonlyArray<string>>; // tool names per turn
};

const toolNamesArb = fc.constantFrom("a", "b", "c");
const turnArb = fc.array(toolNamesArb, { minLength: 0, maxLength: 3 });
const planArb: fc.Arbitrary<Plan> = fc
  .array(turnArb, { minLength: 1, maxLength: 4 })
  .map((turns) => ({ turns }));

// Simple tools that return "ok-<name>". Concurrency inside a batch is
// exercised by `Effect.forEach(..., { concurrency: "unbounded" })` in
// tool-exec.ts — the property must hold under it.
const mkTool = (name: string) =>
  defineTool({
    name,
    description: `tool ${name}`,
    parameters: Schema.Struct({}),
    run: async () => `ok-${name}`,
  });

describe("tool-exec: beacon/result ordering laws", () => {
  it("B1 — beacon seq < result seq for every tool_call_id", async () => {
    await fc.assert(
      fc.asyncProperty(planArb, async (plan) => {
        let turn = 0;
        const infer: InferFn = async (): Promise<InferResponse> => {
          const names = plan.turns[turn] ?? [];
          turn += 1;
          if (names.length === 0) return { content: `done-${turn}` };
          const tool_calls: ToolCall[] = names.map((n, i) => ({
            id: `t${turn}-${i}`,
            type: "function" as const,
            function: { name: n, arguments: "{}" },
          }));
          return { content: "", tool_calls };
        };

        const agent = createAgentRuntime({
          infer,
          tools: [mkTool("a"), mkTool("b"), mkTool("c")],
        });
        try {
          for (let t = 0; t < plan.turns.length; t++) {
            await agent.run(`u${t}`);
            await agent.until((s) => {
              const last = s.events.at(-1);
              if (last?.type === "assistant.message" && !last.tool_calls) return true;
              return null;
            });
          }
          const events = await agent.events();
          const beaconSeq = new Map<string, number>();
          const resultSeq = new Map<string, number>();
          for (const e of events) {
            if (e.type === "tool.call.started") beaconSeq.set(e.tool_call_id, e.seq);
            if (e.type === "tool.result") resultSeq.set(e.tool_call_id, e.seq);
          }
          // For every id that reached tool.result, there's a beacon with lower seq.
          for (const [id, rseq] of resultSeq) {
            const bseq = beaconSeq.get(id);
            expect(bseq, `missing beacon for ${id}`).toBeDefined();
            expect(bseq!).toBeLessThan(rseq);
          }
        } finally {
          await agent.dispose();
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("B2 — exactly one beacon and one result per executed tool_call_id", async () => {
    await fc.assert(
      fc.asyncProperty(planArb, async (plan) => {
        let turn = 0;
        const infer: InferFn = async (): Promise<InferResponse> => {
          const names = plan.turns[turn] ?? [];
          turn += 1;
          if (names.length === 0) return { content: "done" };
          return {
            content: "",
            tool_calls: names.map((n, i) => ({
              id: `t${turn}-${i}`,
              type: "function" as const,
              function: { name: n, arguments: "{}" },
            })),
          };
        };
        const agent = createAgentRuntime({
          infer,
          tools: [mkTool("a"), mkTool("b"), mkTool("c")],
        });
        try {
          for (let t = 0; t < plan.turns.length; t++) {
            await agent.run(`u${t}`);
            await agent.until((s) => {
              const last = s.events.at(-1);
              if (last?.type === "assistant.message" && !last.tool_calls) return true;
              return null;
            });
          }
          const events = await agent.events();
          const beaconCount = new Map<string, number>();
          const resultCount = new Map<string, number>();
          for (const e of events) {
            if (e.type === "tool.call.started") {
              beaconCount.set(e.tool_call_id, (beaconCount.get(e.tool_call_id) ?? 0) + 1);
            }
            if (e.type === "tool.result") {
              resultCount.set(e.tool_call_id, (resultCount.get(e.tool_call_id) ?? 0) + 1);
            }
          }
          for (const [id, c] of beaconCount) {
            expect(c, `duplicate beacon for ${id}`).toBe(1);
          }
          for (const [id, c] of resultCount) {
            expect(c, `duplicate result for ${id}`).toBe(1);
          }
          // Every beacon has a corresponding result (no halt mid-turn in
          // this property — tools always succeed).
          for (const id of beaconCount.keys()) {
            expect(resultCount.get(id), `orphan beacon ${id}`).toBe(1);
          }
        } finally {
          await agent.dispose();
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("B3 — batch atomicity: all beacons for one turn's batch precede all results of that batch", async () => {
    // For each turn that issued K tool calls, the K beacons occupy K
    // contiguous seqs, and those seqs are all strictly below every result
    // seq for the same batch. Proves the "appendMany(intents) then
    // appendMany(results)" two-phase structure in tool-exec.ts:120-146.
    await fc.assert(
      fc.asyncProperty(planArb, async (plan) => {
        let turn = 0;
        const infer: InferFn = async (): Promise<InferResponse> => {
          const names = plan.turns[turn] ?? [];
          turn += 1;
          if (names.length === 0) return { content: "done" };
          return {
            content: "",
            tool_calls: names.map((n, i) => ({
              id: `t${turn}-${i}`,
              type: "function" as const,
              function: { name: n, arguments: "{}" },
            })),
          };
        };
        const agent = createAgentRuntime({
          infer,
          tools: [mkTool("a"), mkTool("b"), mkTool("c")],
        });
        try {
          for (let t = 0; t < plan.turns.length; t++) {
            await agent.run(`u${t}`);
            await agent.until((s) => {
              const last = s.events.at(-1);
              if (last?.type === "assistant.message" && !last.tool_calls) return true;
              return null;
            });
          }
          const events = await agent.events();
          for (let t = 1; t <= plan.turns.length; t++) {
            const names = plan.turns[t - 1]!;
            if (names.length === 0) continue;
            const ids = names.map((_, i) => `t${t}-${i}`);
            const beaconSeqs = ids.map((id) => {
              const e = events.find(
                (x) => x.type === "tool.call.started" && x.tool_call_id === id,
              );
              expect(e, `missing beacon ${id}`).toBeDefined();
              return e!.seq;
            });
            const resultSeqs = ids.map((id) => {
              const e = events.find(
                (x) => x.type === "tool.result" && x.tool_call_id === id,
              );
              expect(e, `missing result ${id}`).toBeDefined();
              return e!.seq;
            });
            // Contiguous beacon block.
            const sortedB = [...beaconSeqs].sort((a, b) => a - b);
            for (let i = 1; i < sortedB.length; i++) {
              expect(sortedB[i]).toBe(sortedB[i - 1]! + 1);
            }
            // All beacons strictly below all results.
            const maxBeacon = Math.max(...beaconSeqs);
            const minResult = Math.min(...resultSeqs);
            expect(maxBeacon).toBeLessThan(minResult);
          }
        } finally {
          await agent.dispose();
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
