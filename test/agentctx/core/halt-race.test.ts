import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { AgentCtx, createAgentRuntime } from "@flamecast/agentctx";
import type { Event, Tool } from "@flamecast/agentctx";
import { scriptedInfer, toolCall } from "../helpers/scripted-infer";

// Predicate helpers. Each returns T|null so it slots into `agent.until`.
const hasBeacon = (s: { events: ReadonlyArray<Event> }): true | null =>
  s.events.some((e) => e.type === "tool.call.started") ? true : null;

const hasToolResult = (id: string) => (s: { events: ReadonlyArray<Event> }) => {
  const hit = s.events.find(
    (e) => e.type === "tool.result" && e.tool_call_id === id,
  );
  return hit ?? null;
};

describe("agentctx: halt race vs in-flight tool batch", () => {
  it("writes tool.result even when assistant.halted lands mid-execution, and suppresses further inference", async () => {
    // Scenario:
    //   1. user.message → inference fires → assistant.message(tool_calls) appended
    //   2. tool-exec fiber writes tool.call.started beacon + invokes tool.run
    //   3. while tool.run awaits an external gate, we append assistant.halted
    //   4. tool.run resolves → tool.result MUST still append (side effect ran)
    //   5. post-halt sends do NOT drain, no new inference fires.
    //
    // Real time is unavoidable here because the tool's run is a plain
    // Promise around a JS gate — Effect's TestClock doesn't control it.
    // We synchronize on log state via `until` rather than fixed sleeps.

    let releaseGate!: (v: string) => void;
    const gate = new Promise<string>((resolve) => {
      releaseGate = resolve;
    });
    let runCount = 0;

    const sendSlack: Tool = {
      name: "sendSlack",
      description: "non-idempotent",
      parameters: { type: "object", properties: {} },
      run: async () => {
        runCount++;
        return await gate;
      },
    };

    // Infer step 1 triggers the tool; step 2 exists only to prove it is
    // NEVER invoked post-halt (scriptedInfer throws on exhaustion).
    const agent = createAgentRuntime({
      infer: scriptedInfer([
        { content: "", tool_calls: [toolCall("t1", "sendSlack", {})] },
        { content: "should-not-fire-after-halt" },
      ]),
      tools: [sendSlack],
    });

    try {
      agent.send("go");

      // Wait for beacon + tool.run to be live.
      await agent.until(hasBeacon);
      expect(runCount).toBe(1);

      // Append assistant.halted directly via the runtime — simulates a
      // racing extension (maxSteps, policy, abort) concluding mid-tool.
      await agent.runtime.runPromise(
        Effect.gen(function* () {
          const ctx = yield* AgentCtx;
          yield* ctx.events.append({ type: "assistant.halted", reason: "policy" });
        }),
      );

      // Release the tool — its result must still land per invariant 5.
      releaseGate("slack-sent");

      const result = await agent.until(hasToolResult("t1"));
      expect(result).toMatchObject({
        type: "tool.result",
        tool_call_id: "t1",
        content: "slack-sent",
      });

      const final = await agent.events();
      // Every beacon must have a paired result (no silent interruption).
      for (const e of final) {
        if (e.type === "tool.call.started") {
          const paired = final.find(
            (x) => x.type === "tool.result" && x.tool_call_id === e.tool_call_id,
          );
          expect(paired, `missing tool.result for ${e.tool_call_id}`).toBeDefined();
        }
      }

      // Post-halt, same turn: no new inference. But with per-turn halt
      // semantics, a NEW user.message un-halts the agent and inference
      // resumes — scriptedInfer step 2 fires for the "again" turn.
      const eventsBeforeSecondSend = final.length;
      await agent.send("again");
      const resumed = await agent.until((s) => {
        const last = s.events.at(-1);
        return last?.type === "assistant.message" &&
          last.content === "should-not-fire-after-halt"
          ? last
          : null;
      });
      expect(resumed.content).toBe("should-not-fire-after-halt");

      const after = await agent.events();
      const lateUser = after
        .slice(eventsBeforeSecondSend)
        .find((e) => e.type === "user.message" && e.content === "again");
      expect(lateUser).toBeDefined();
    } finally {
      await agent.dispose();
    }
  });

  it("pending-sends queued during tool execution do NOT drain after halt", async () => {
    // Stronger version of the prior assertion: send arrives WHILE tools
    // are in flight (queued into PendingSends), then halt lands, then
    // tool resolves. The drain branch in tool-exec must skip because
    // halt is set when `post = yield* ctx.events.snapshot` is checked.
    let releaseGate!: (v: string) => void;
    const gate = new Promise<string>((resolve) => {
      releaseGate = resolve;
    });

    const sendSlack: Tool = {
      name: "sendSlack",
      description: "non-idempotent",
      parameters: { type: "object", properties: {} },
      run: async () => await gate,
    };

    const agent = createAgentRuntime({
      infer: scriptedInfer([
        { content: "", tool_calls: [toolCall("t1", "sendSlack", {})] },
      ]),
      tools: [sendSlack],
    });

    try {
      agent.send("go");
      await agent.until(hasBeacon);

      // Queue a user message — tools are in flight so this goes into
      // PendingSends rather than the event log.
      agent.send("queued-mid-tool");

      // Halt lands now.
      await agent.runtime.runPromise(
        Effect.gen(function* () {
          const ctx = yield* AgentCtx;
          yield* ctx.events.append({ type: "assistant.halted", reason: "policy" });
        }),
      );

      releaseGate("ok");

      // Wait for tool.result.
      await agent.until(hasToolResult("t1"));

      // Small settle window for the (non-)drain to not drain.
      await new Promise<void>((r) => setTimeout(r, 50));

      const events = await agent.events();
      const queuedLanded = events.find(
        (e) => e.type === "user.message" && e.content === "queued-mid-tool",
      );
      // Invariant: pending-send message must not have been drained into
      // the log post-halt — there's no live agent to consume it.
      expect(queuedLanded).toBeUndefined();
    } finally {
      await agent.dispose();
    }
  });
});
