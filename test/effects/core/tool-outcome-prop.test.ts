import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createAgentRuntime } from "@flamecast/agentctx";
import type { Event, InferFn, InferResponse, Tool, ToolCall } from "@flamecast/agentctx";

// Algebraic property tests for:
//
//   X1. ToolOutcome `extraEvents` ordering: for any tool that returns
//       `{ content, extraEvents: [e1, e2, ...] }`, the events appear in
//       the log BEFORE the `tool.result` in a CONTIGUOUS block with
//       dense seqs, and the `tool.result` immediately follows them.
//       Pins the contract in tool-exec.ts:132-146 + types.ts:39-44.
//   X2. Async tool errors surface on `ctx.errors`: if a tool's `run`
//       throws (either sync throw or promise rejection), the
//       `ToolExecutionError` appears on `ctx.errors` AND the LLM sees a
//       `tool.result` with string content starting "Error:". Pins the
//       dev-visibility path in tool-exec.ts:86-106.
//
// These together cover the two big remaining gaps from the spike's
// earlier-identified list.

const PER_CASE_TIMEOUT_MS = 5_000;

const withTimeout = async <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

describe("tool outcomes: extraEvents ordering + error surfacing", () => {
  it(
    "X1 — extraEvents are appended in order, contiguously, immediately before the tool.result",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          // Arbitrary number of extra events + their content. Using
          // compaction.summary as the extra event type — it's the real
          // production use case (compact tool) and its fields are
          // structural enough to identify individual events.
          fc.array(fc.string({ minLength: 1, maxLength: 4 }), {
            minLength: 1,
            maxLength: 4,
          }),
          async (extraTexts) => {
            const tool: Tool = {
              name: "batched",
              description: "returns extras",
              parameters: { type: "object", properties: {} },
              run: async () => ({
                content: "done",
                extraEvents: extraTexts.map((text, i) => ({
                  type: "compaction.summary" as const,
                  fromSeq: 0,
                  toSeq: i,
                  text,
                })),
              }),
            };

            const callId = "c1";
            let turn = 0;
            const infer: InferFn = async (): Promise<InferResponse> => {
              turn++;
              if (turn === 1) {
                const tc: ToolCall = {
                  id: callId,
                  type: "function",
                  function: { name: "batched", arguments: "{}" },
                };
                return { content: "", tool_calls: [tc] };
              }
              return { content: "ok" };
            };

            const agent = createAgentRuntime({ infer, tools: [tool] });
            try {
              await agent.send("go");
              await withTimeout(
                agent.until((s) => {
                  const last = s.events.at(-1);
                  return last?.type === "assistant.message" && !last.tool_calls
                    ? true
                    : null;
                }),
                PER_CASE_TIMEOUT_MS,
                "second turn",
              );

              const events: ReadonlyArray<Event> = await agent.events();
              const resultIdx = events.findIndex(
                (e) => e.type === "tool.result" && e.tool_call_id === callId,
              );
              expect(resultIdx).toBeGreaterThan(0);

              // The `extraTexts.length` events immediately preceding the
              // tool.result must be the declared compaction.summary events,
              // in order.
              const k = extraTexts.length;
              for (let i = 0; i < k; i++) {
                const ev = events[resultIdx - k + i];
                expect(ev, `event at ${resultIdx - k + i}`).toBeDefined();
                expect(ev!.type).toBe("compaction.summary");
                if (ev!.type === "compaction.summary") {
                  expect(ev!.text).toBe(extraTexts[i]);
                }
              }

              // Dense seqs: resultIdx-k .. resultIdx must form a contiguous
              // seq range [s, s+k] and match their positions in the log.
              const base = events[resultIdx - k]!;
              for (let i = 0; i <= k; i++) {
                expect(events[resultIdx - k + i]!.seq).toBe(base.seq + i);
              }
            } finally {
              await agent.dispose();
            }
          },
        ),
        { numRuns: 10 },
      );
    },
    60_000,
  );

  it(
    "X2 — a tool that throws surfaces on ctx.errors AND produces an Error: string result",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 20 }),
          async (errMsg) => {
            const callId = "c1";
            const tool: Tool = {
              name: "buggy",
              description: "throws",
              parameters: { type: "object", properties: {} },
              run: async () => {
                throw new Error(errMsg);
              },
            };

            let turn = 0;
            const infer: InferFn = async (): Promise<InferResponse> => {
              turn++;
              if (turn === 1) {
                return {
                  content: "",
                  tool_calls: [
                    {
                      id: callId,
                      type: "function",
                      function: { name: "buggy", arguments: "{}" },
                    },
                  ],
                };
              }
              return { content: "ok" };
            };

            const agent = createAgentRuntime({ infer, tools: [tool] });
            try {
              await agent.send("go");
              await withTimeout(
                agent.until((s) => {
                  const last = s.events.at(-1);
                  return last?.type === "assistant.message" && !last.tool_calls
                    ? true
                    : null;
                }),
                PER_CASE_TIMEOUT_MS,
                "second turn",
              );

              // LLM-facing: tool.result starts with "Error:" and contains the message.
              const events = await agent.events();
              const toolResult = events.find(
                (e) => e.type === "tool.result" && e.tool_call_id === callId,
              );
              expect(toolResult).toBeDefined();
              if (toolResult && toolResult.type === "tool.result") {
                expect(toolResult.content.startsWith("Error:")).toBe(true);
                expect(toolResult.content).toContain(errMsg);
              }

              // Dev-facing: ctx.errors has a ToolExecutionError for this tool.
              const errs = await agent.errors();
              const match = errs.find((e) => e.phase === "tool:buggy");
              expect(match, "ToolExecutionError not on ctx.errors").toBeDefined();
            } finally {
              await agent.dispose();
            }
          },
        ),
        { numRuns: 10 },
      );
    },
    60_000,
  );
});
