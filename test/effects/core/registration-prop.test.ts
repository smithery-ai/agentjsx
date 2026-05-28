import fc from "fast-check";
import { Chunk, Effect, Exit, Scope, SubscriptionRef } from "effect";
import { describe, expect, it } from "vitest";
import { AgentCtx } from "@flamecast/agentjsx/agent-ctx";
import { createAgentRuntime } from "@flamecast/agentjsx";
import type { InferFn, InferResponse, Tool } from "@flamecast/agentjsx";

// Algebraic property tests for the extension lifecycle:
//
//   D1. Duplicate tool names ALWAYS throw `DuplicateToolError` at install
//       time. For any pair of tool additions with the same name, the
//       second addTool fails with DuplicateToolError. Pins the claim
//       from CLAUDE.md principle 6 anti-pattern: duplicate names must
//       throw, not silently shadow.
//   D2. Distinct tool names ALWAYS install successfully and end up in
//       `ctx.tools` exactly once each.
//   S1. Scoped teardown — closing an extension's scope removes its
//       contributions from `ctx.tools`. After install + dispose, the
//       tool list returns to the pre-install baseline. Validates the
//       `Effect.acquireRelease` finalizer in agent-ctx.ts:208-221.

const NUM_RUNS = 30;

const stubInfer: InferFn = async (): Promise<InferResponse> => ({
  content: "stub",
});

const mkTool = (name: string): Tool => ({
  name,
  description: `tool ${name}`,
  parameters: { type: "object", properties: {} },
  run: async () => `ok-${name}`,
});

const toolNameArb = fc.constantFrom("a", "b", "c", "d", "e");

describe("tool registration: duplicate detection + scoped teardown", () => {
  it("D1 — adding two tools with the same name fails with DuplicateToolError", async () => {
    await fc.assert(
      fc.asyncProperty(toolNameArb, async (name) => {
        const agent = createAgentRuntime({
          infer: stubInfer,
          tools: [mkTool(name)],
        });
        try {
          // Open a fresh scope, call addTool with the already-present
          // name, capture the Exit. Error channel must contain
          // DuplicateToolError. Effect.scoped closes the scope either
          // way so the Exit reflects the acquire failure cleanly.
          const exit = await agent.runtime.runPromiseExit(
            Effect.scoped(
              Effect.gen(function* () {
                const ctx = yield* AgentCtx;
                yield* ctx.addTool(mkTool(name));
              }),
            ),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const json = JSON.stringify(exit.cause);
            expect(json).toContain("DuplicateToolError");
            expect(json).toContain(name);
          }
        } finally {
          await agent.dispose();
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("D2 — installing N distinct-named tools succeeds and exposes each exactly once on ctx.tools", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(toolNameArb, { minLength: 0, maxLength: 5 }),
        async (names) => {
          const agent = createAgentRuntime({
            infer: stubInfer,
            tools: names.map(mkTool),
          });
          try {
            const installed = await agent.runtime.runPromise(
              Effect.gen(function* () {
                const ctx = yield* AgentCtx;
                const chunk = yield* SubscriptionRef.get(ctx.tools);
                return Chunk.toReadonlyArray(chunk).map((t) => t.name);
              }),
            );
            for (const n of names) {
              const count = installed.filter((x) => x === n).length;
              expect(count, `tool ${n} count`).toBe(1);
            }
          } finally {
            await agent.dispose();
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("S1 — closing a child scope unregisters its addTool contribution", async () => {
    // Open a child Scope, acquire a tool via `ctx.addTool` inside it,
    // observe `ctx.tools` contains the tool, close the scope, observe
    // the tool is gone. Validates the finalizer in agent-ctx.ts:208-221.
    await fc.assert(
      fc.asyncProperty(toolNameArb, async (name) => {
        const agent = createAgentRuntime({ infer: stubInfer });
        try {
          const readNames = (): Promise<string[]> =>
            agent.runtime.runPromise(
              Effect.gen(function* () {
                const ctx = yield* AgentCtx;
                const chunk = yield* SubscriptionRef.get(ctx.tools);
                return Chunk.toReadonlyArray(chunk).map((t) => t.name);
              }),
            );

          const before = await readNames();
          expect(before).not.toContain(name);

          const childScope = await agent.runtime.runPromise(Scope.make());
          await agent.runtime.runPromise(
            Effect.gen(function* () {
              const ctx = yield* AgentCtx;
              yield* Scope.extend(ctx.addTool(mkTool(name)), childScope);
            }),
          );
          const during = await readNames();
          expect(during).toContain(name);

          await agent.runtime.runPromise(
            Scope.close(childScope, Exit.void),
          );
          const after = await readNames();
          expect(after).not.toContain(name);
          expect(after).toEqual(before);
        } finally {
          await agent.dispose();
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
