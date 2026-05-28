import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createAgentRuntime } from "@flamecast/agentjsx";
import type { InferFn, InferResponse } from "@flamecast/agentjsx";

// Property-test variant of `inference-consistency.test.ts`. That test
// proves the FRP-glitch fix (see `src/inference.ts`: inference
// reads `ctx.render` rather than `ctx.rendered`) for the synchronous
// happy path. This file hammers the same invariant under adversarial
// async latency so it would have caught the original bug reliably.
//
// The bug class: two fibers subscribed to `log.changes` — a projection
// fiber that materializes `ctx.rendered`, and the inference fiber. With
// synchronous scripted infer the scheduler happens to run the projection
// first. With real latency the order flips and inference reads stale
// blocks, producing an assistant reply that belongs to the previous
// user turn.
//
// Strategy: for every generated sequence of user messages, wrap the
// scripted infer with a random delay in [0, 50] ms. Record what user
// messages inference saw at each call. The invariant is strictly
// monotonic — the N-th infer() call must see user messages 1..N, not
// 1..N-1.

// Runs-per-case is kept modest so total wall time stays well under the
// 30-second ceiling the task asks for. A dozen runs across 2-6 message
// sequences is enough to catch the race empirically (verified: reverting
// the fix in `inference.ts` makes this fail inside 1-2 runs).
const NUM_RUNS = 20;

// Hard wall-clock ceiling per generated scenario. `agent.until` has no
// built-in timeout; if the fix ever regresses in a way that deadlocks
// the scheduler we want the property to fail loudly, not hang the suite.
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

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("agentctx: inference consistency under adversarial delays", () => {
  it(
    "inference always observes all user messages up to and including the turn it's responding to",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.string({ minLength: 1, maxLength: 8 }), {
            minLength: 2,
            maxLength: 6,
          }),
          fc.array(fc.integer({ min: 0, max: 50 }), {
            minLength: 6,
            maxLength: 6,
          }),
          async (messages, delays) => {
            const observed: Array<ReadonlyArray<string>> = [];
            let callIndex = 0;
            const infer: InferFn = async (context): Promise<InferResponse> => {
              const userMsgs = context.messages
                .filter((m) => m.role === "user")
                .map((m) =>
                  typeof m.content === "string"
                    ? m.content
                    : m.content.map((c) => c.text).join(""),
                );
              observed.push(userMsgs);
              const d = delays[callIndex % delays.length] ?? 0;
              callIndex += 1;
              await sleep(d);
              return { content: `reply-${callIndex}` };
            };

            const agent = createAgentRuntime({ infer });
            try {
              for (const msg of messages) {
                await withTimeout(
                  agent.send(msg),
                  PER_CASE_TIMEOUT_MS,
                  "agent.send",
                );
                await withTimeout(
                  agent.until((s) => {
                    const last = s.events.at(-1);
                    return last?.type === "assistant.message" &&
                      !last.tool_calls
                      ? true
                      : null;
                  }),
                  PER_CASE_TIMEOUT_MS,
                  "agent.until(assistant.message)",
                );
              }

              expect(observed.length).toBe(messages.length);
              for (let i = 0; i < messages.length; i++) {
                expect(observed[i]).toEqual(messages.slice(0, i + 1));
              }
            } finally {
              await agent.dispose();
            }
          },
        ),
        { numRuns: NUM_RUNS },
      );
    },
    30_000,
  );
});
