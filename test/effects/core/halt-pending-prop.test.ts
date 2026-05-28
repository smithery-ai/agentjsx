import fc from "fast-check";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { AgentCtx, createAgentRuntime } from "@flamecast/agentjsx";
import type { Tool, Event } from "@flamecast/agentjsx";
import { scriptedInfer, toolCall } from "../../agentctx/helpers/scripted-infer";

// End-to-end algebraic property tests for two halt-related invariants
// that previously had only single example coverage in `halt-race.test.ts`:
//
//   HP1 (invariant 5: result append survives halt). For any tool batch
//        of size K and any halt insertion point in {pre-batch, mid-batch,
//        post-batch}, every beacon ends up paired with a tool.result —
//        side effects that ran are recorded.
//   HP2 (invariant 7: pending-sends drain on results, skip on halt).
//        If `agent.run` is called while tools are in flight AND a halt
//        lands before the tools complete, the queued user.message MUST
//        NOT appear in the log after tools complete.
//
// These pin the load-bearing semantics of crash-safe halt: side effects
// are remembered (the log is the authority on what ran), but post-halt
// agent activity is suppressed (no surprise inference firing into a
// session the operator already shut down).

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

const hasBeacon = (s: { events: ReadonlyArray<Event> }): true | null =>
  s.events.some((e) => e.type === "tool.call.started") ? true : null;

const hasResultsForAll = (ids: ReadonlyArray<string>) => (
  s: { events: ReadonlyArray<Event> },
): true | null => {
  const got = new Set(
    s.events
      .filter((e) => e.type === "tool.result")
      .map((e) => {
        if (e.type !== "tool.result") throw new Error("unreachable");
        return e.tool_call_id;
      }),
  );
  return ids.every((id) => got.has(id)) ? true : null;
};

describe("halt + pending-sends: end-to-end laws", () => {
  it(
    "HP1 — every beacon ends up paired with a tool.result, regardless of when halt lands",
    async () => {
      // Halt phase is chosen deterministically rather than by wall-clock
      // delay, so each generated case reliably exercises one specific
      // halt interleaving instead of a timing-dependent one that may
      // collapse under CI load.
      //
      //   "before-release"   — halt lands AFTER beacons, BEFORE any tool resolves.
      //   "mid-release"      — halt lands between resolving tool 0 and tools 1..k-1.
      //   "after-release"    — halt lands AFTER all tools resolve (but before results
      //                        have landed in the log, assuming modify-race).
      const phaseArb = fc.constantFrom(
        "before-release",
        "mid-release",
        "after-release",
      ) as fc.Arbitrary<"before-release" | "mid-release" | "after-release">;

      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 3 }),
          phaseArb,
          async (k, phase) => {
            const releasers: Array<(v: string) => void> = [];
            const gates: Promise<string>[] = [];
            const tools: Tool[] = [];
            const ids: string[] = [];
            for (let i = 0; i < k; i++) {
              const id = `t-${i}`;
              ids.push(id);
              gates.push(
                new Promise<string>((resolve) => {
                  releasers.push(resolve);
                }),
              );
              tools.push({
                name: `tool${i}`,
                description: "x",
                parameters: { type: "object", properties: {} },
                run: async () => await gates[i]!,
              });
            }

            const calls = ids.map((id, i) => toolCall(id, `tool${i}`, {}));
            const agent = createAgentRuntime({
              infer: scriptedInfer([
                { content: "", tool_calls: calls },
                { content: "noop" },
              ]),
              tools,
            });

            const halt = (): Promise<void> =>
              agent.runtime.runPromise(
                Effect.gen(function* () {
                  const ctx = yield* AgentCtx;
                  yield* ctx.events.append({
                    type: "assistant.halted",
                    reason: "policy",
                  });
                }),
              );

            try {
              agent.run("go");
              await withTimeout(agent.until(hasBeacon), PER_CASE_TIMEOUT_MS, "beacon");

              if (phase === "before-release") {
                await halt();
                for (let i = 0; i < releasers.length; i++) releasers[i]!(`ok-${i}`);
              } else if (phase === "mid-release" && k > 1) {
                releasers[0]!("ok-0");
                await halt();
                for (let i = 1; i < releasers.length; i++) releasers[i]!(`ok-${i}`);
              } else {
                // phase === "after-release" or k === 1 mid-release fallback
                for (let i = 0; i < releasers.length; i++) releasers[i]!(`ok-${i}`);
                await halt();
              }

              await withTimeout(
                agent.until(hasResultsForAll(ids)),
                PER_CASE_TIMEOUT_MS,
                "results",
              );

              const events = await agent.events();
              for (const e of events) {
                if (e.type === "tool.call.started") {
                  const paired = events.find(
                    (x) =>
                      x.type === "tool.result" && x.tool_call_id === e.tool_call_id,
                  );
                  expect(paired, `unpaired beacon ${e.tool_call_id}`).toBeDefined();
                }
              }
            } finally {
              await agent.dispose();
            }
          },
        ),
        { numRuns: 12 },
      );
    },
    60_000,
  );

  it(
    "HP2 — user.message queued mid-tool does NOT land in the log after halt",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 8 }), // queued message content
          async (queued) => {
            let releaseGate!: (v: string) => void;
            const gate = new Promise<string>((resolve) => {
              releaseGate = resolve;
            });

            const tool: Tool = {
              name: "t",
              description: "x",
              parameters: { type: "object", properties: {} },
              run: async () => await gate,
            };

            const agent = createAgentRuntime({
              infer: scriptedInfer([
                { content: "", tool_calls: [toolCall("c1", "t", {})] },
              ]),
              tools: [tool],
            });
            try {
              agent.run("go");
              await withTimeout(agent.until(hasBeacon), PER_CASE_TIMEOUT_MS, "beacon");

              // Queue mid-tool — goes to PendingSends, not the log.
              agent.run(queued);

              // Halt lands.
              await agent.runtime.runPromise(
                Effect.gen(function* () {
                  const ctx = yield* AgentCtx;
                  yield* ctx.events.append({
                    type: "assistant.halted",
                    reason: "policy",
                  });
                }),
              );

              releaseGate("done");
              await withTimeout(
                agent.until(hasResultsForAll(["c1"])),
                PER_CASE_TIMEOUT_MS,
                "result",
              );
              // Settle so the (non-)drain has a chance to misbehave.
              await new Promise<void>((r) => setTimeout(r, 50));

              const events = await agent.events();
              const queuedLanded = events.find(
                (e) => e.type === "user.message" && e.content === queued,
              );
              expect(queuedLanded, "queued send must not land post-halt").toBeUndefined();
            } finally {
              await agent.dispose();
            }
          },
        ),
        { numRuns: 8 },
      );
    },
    60_000,
  );
});
