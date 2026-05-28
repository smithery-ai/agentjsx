// End-to-end test for the JSX-component API driving createAgentRuntime.
//
// Wires a scripted InferFn through a `context: () => render(<Agent>…)`
// callback and proves: tool reconciliation installs the Workspace tools,
// the role/workspace blocks land in the provider context's system prompt,
// the agent can call a tool and observe its result, and a final
// assistant.message terminates the run. The reconciler-by-name behavior
// is verified by reading the live tools snapshot through the runtime
// escape hatch after the run completes — the count must equal the
// declared 5, not 10.

import { Chunk, Effect, SubscriptionRef } from "effect";
import { describe, expect, it } from "vitest";
import { AgentCtx, createAgentRuntime, render } from "@flamecast/agentjsx";
import { createElement, Agent, Block, Messages, Workspace } from "@flamecast/agentjsx/components";
import type { Event, InferFn, ProviderContext } from "@flamecast/agentjsx";

// `createElement` is referenced by the classic-JSX-compiled output of
// the <Agent>...</Agent> expressions below. The explicit import keeps
// `verbatimModuleSyntax` happy and pins the factory to the runtime in
// this package (not React's).
void createElement;

describe("jsx end-to-end", () => {
  it("renders an Agent tree through createAgentRuntime and runs a tool", async () => {
    const seenContexts: ProviderContext[] = [];
    let turn = 0;
    const infer: InferFn = async (context) => {
      seenContexts.push(context);
      turn++;
      if (turn === 1) {
        return {
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "list_dir",
                arguments: JSON.stringify({ path: "./" }),
              },
            },
          ],
        };
      }
      return { content: "Listed: workspace contents.", tool_calls: [] };
    };

    const agent = createAgentRuntime({
      infer,
      context: () =>
        render(
          <Agent>
            <Block name="role">You are a coding assistant.</Block>
            <Workspace root="./" />
            <Messages />
          </Agent>,
        ),
    });

    try {
      await agent.send("list the workspace");

      // Wait for the final assistant.message that carries the turn-2 text.
      const finalMsg = await agent.until<Event>((snap) => {
        for (let i = snap.events.length - 1; i >= 0; i--) {
          const e = snap.events[i]!;
          if (
            e.type === "assistant.message" &&
            e.content === "Listed: workspace contents."
          ) {
            return e;
          }
        }
        return null;
      });
      expect(finalMsg.type).toBe("assistant.message");

      // ---- Assertion 1: tool reconciliation installed 5 Workspace tools.
      // Read the live tools SubscriptionRef via the runtime escape hatch.
      const liveToolNames = await agent.runtime.runPromise(
        Effect.gen(function* () {
          const ctx = yield* AgentCtx;
          const tools = yield* SubscriptionRef.get(ctx.tools);
          return Chunk.toReadonlyArray(tools).map((t) => t.name);
        }),
      );
      const expectedNames = [
        "bash",
        "read_file",
        "write_file",
        "grep",
        "list_dir",
      ];
      for (const name of expectedNames) {
        expect(liveToolNames).toContain(name);
      }

      // ---- Assertion 6 (reconciler key-by-name): exactly 5 tools after
      // many re-renders. The render driver re-invokes `contextFn` on
      // every event/tools change; if the reconciler weren't keying by
      // name, each turn would have appended another 5.
      expect(liveToolNames.length).toBe(5);

      // ---- Assertion 2: role block landed in the system prompt.
      // Inspect the first ProviderContext that infer saw.
      const firstCtx = seenContexts[0];
      expect(firstCtx).toBeDefined();
      const systemString = (ctx: ProviderContext): string => {
        if (typeof ctx.system === "string") return ctx.system;
        return ctx.system.map((c) => c.text).join("");
      };
      const sys1 = systemString(firstCtx!);
      expect(sys1).toContain("You are a coding assistant.");

      // ---- Assertion 3: workspace placeholder block landed.
      expect(sys1).toContain('<workspace root="./">');

      // ---- Assertion 4: the tool actually ran. Without an
      // `opts.platform` layer wired to this runtime, FileSystem is
      // unresolved and the tool returns its caught-error string. The
      // real-platform e2e lives in stage 4.
      const events = await agent.events();
      const toolResult = events.find(
        (e) => e.type === "tool.result" && e.tool_call_id === "call_1",
      );
      expect(toolResult).toBeDefined();
      expect(toolResult).toMatchObject({
        type: "tool.result",
        tool_call_id: "call_1",
      });
      expect(
        (toolResult as Extract<Event, { type: "tool.result" }>).content,
      ).toMatch(/^\[list_dir\] Error: /);

      // Confirm infer saw the list_dir tool in its declared toolset on turn 1.
      const declaredOnTurn1 = firstCtx!.tools.map((t) => t.name);
      expect(declaredOnTurn1).toEqual(
        expect.arrayContaining(expectedNames),
      );

      // ---- Assertion 5: final assistant.message is the turn-2 reply.
      // It must be the last assistant.message in the log, with the
      // expected content and no tool_calls.
      const assistantMsgs = events.filter(
        (e) => e.type === "assistant.message",
      );
      const last = assistantMsgs[assistantMsgs.length - 1];
      expect(last).toMatchObject({
        type: "assistant.message",
        content: "Listed: workspace contents.",
      });
      const lastTc = (last as Extract<Event, { type: "assistant.message" }>)
        .tool_calls;
      expect(lastTc === undefined || lastTc.length === 0).toBe(true);

      // Sanity: exactly two infer calls happened.
      expect(turn).toBe(2);
      expect(seenContexts.length).toBe(2);
    } finally {
      await agent.dispose();
    }
  });
});
