import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { AgentCtx, createAgentRuntime, maxSteps } from "@flamecast/agentjsx";
import type { Event, Tool } from "@flamecast/agentjsx";
import { scriptedInfer, toolCall } from "../helpers/scripted-infer";

const hasHalt = (s: { events: ReadonlyArray<Event> }): Event | null =>
  s.events.find((e) => e.type === "assistant.halted") ?? null;

const assistantCount = (events: ReadonlyArray<Event>): number =>
  events.filter((e) => e.type === "assistant.message").length;

describe("agentctx: maxSteps extension", () => {
  it("halts after the Nth assistant.message WITHIN A TURN", async () => {
    // maxSteps is per-turn: it caps a single task's tool-use depth.
    // To exercise a multi-assistant turn without user intervention, the
    // scripted infer keeps returning tool_calls so the tool-exec loop
    // drives inference again after each tool.result.
    const ping: Tool = {
      name: "ping",
      description: "",
      parameters: { type: "object", properties: {} },
      run: async () => "pong",
    };
    const agent = createAgentRuntime({
      infer: scriptedInfer([
        { content: "", tool_calls: [toolCall("t1", "ping")] },
        { content: "", tool_calls: [toolCall("t2", "ping")] },
        { content: "SHOULD-NOT-FIRE" },
      ]),
      tools: [ping],
      extensions: [maxSteps(2)],
    });

    try {
      await agent.run("go");
      const halt = await agent.until(hasHalt);
      expect(halt.type).toBe("assistant.halted");
      const events = await agent.events();
      expect(assistantCount(events)).toBe(2);
    } finally {
      await agent.dispose();
    }
  });

  it("new user.message after halt resumes inference (per-turn halt semantics)", async () => {
    // Previously halt was absorbing forever. New semantic: halt is
    // absorbing within a turn but NOT across turns — the next
    // user.message un-halts the agent. Drive by manually appending a
    // halt and verifying the next send produces a new assistant.message.
    const agent = createAgentRuntime({
      infer: scriptedInfer([{ content: "first" }, { content: "second" }]),
    });

    try {
      await agent.run("one");
      const firstReply = await agent.until((s) => {
        const last = s.events.at(-1);
        return last?.type === "assistant.message" && last.content === "first"
          ? last
          : null;
      });

      await agent.runtime.runPromise(
        Effect.gen(function* () {
          const ctx = yield* AgentCtx;
          yield* ctx.events.append({
            type: "assistant.halted",
            reason: "policy test",
          });
        }),
      );

      await agent.run("two");
      const resumed = await agent.until((s) => {
        const last = s.events.at(-1);
        return last?.type === "assistant.message" && last.content === "second"
          ? last
          : null;
      });
      expect(resumed.content).toBe("second");

      // Sanity: both the halt and the resumed assistant.message are in
      // the log in causal order.
      const events = await agent.events();
      const haltIdx = events.findIndex((e) => e.type === "assistant.halted");
      const resumedIdx = events.findIndex(
        (e) => e.type === "assistant.message" && e.content === "second",
      );
      expect(haltIdx).toBeLessThan(resumedIdx);
      expect(firstReply.seq).toBeLessThan(events[haltIdx].seq);
    } finally {
      await agent.dispose();
    }
  });
});
