import { describe, expect, it, vi } from "vitest";
import { createAgentRuntime, summarize } from "@flamecast/agentjsx";
import type { Fragment, InferFn } from "@flamecast/agentjsx";
import { scriptedInfer } from "../helpers/scripted-infer";

const waitForAssistantCount = async (
  agent: ReturnType<typeof createAgentRuntime>,
  n: number,
): Promise<void> => {
  await agent.until((s) => {
    const count = s.events.filter((e) => e.type === "assistant.message").length;
    return count >= n ? true : null;
  });
};

describe("agentctx: summarize extension", () => {
  it("re-fires when conversation grows past the last-summarized boundary", async () => {
    // maxEvents is the threshold for conversation events accumulated
    // since the last boundary (or from the start if none). Additive:
    // each firing appends one compaction.summary event; subsequent fires
    // summarize only the new slice.
    const summarizeCalls: number[] = [];
    const summarizeFn = async (): Promise<string> => {
      summarizeCalls.push(Date.now());
      return `summary-${summarizeCalls.length}`;
    };
    const infer: InferFn = async () => ({ content: "ack" });

    const agent = createAgentRuntime({
      infer,
      extensions: [
        summarize({
          maxEvents: 3,
          tail: 1,
          summarize: summarizeFn,
        }),
      ],
    });

    try {
      // Turns 1..3 accumulate until the new-slice conv count exceeds 3.
      agent.send("t1");
      await waitForAssistantCount(agent, 1);
      agent.send("t2");
      await waitForAssistantCount(agent, 2);
      agent.send("t3");
      await waitForAssistantCount(agent, 3);
      await agent.until(() => (summarizeCalls.length >= 1 ? true : null));

      // Turns 4..5 keep growing past the first boundary — a second fire
      // must follow as the new slice crosses the threshold again.
      agent.send("t4");
      await waitForAssistantCount(agent, 4);
      agent.send("t5");
      await waitForAssistantCount(agent, 5);
      await agent.until(() => (summarizeCalls.length >= 2 ? true : null));
      expect(summarizeCalls.length).toBeGreaterThanOrEqual(2);

      // Boundaries stack additively: each fire produces one
      // compaction.summary event.
      const events = await agent.events();
      const boundaries = events.filter((e) => e.type === "compaction.summary");
      expect(boundaries.length).toBeGreaterThanOrEqual(2);
    } finally {
      await agent.dispose();
    }
  });

  it("reports each summarize failure and a terminal disable event after maxFailures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const agent = createAgentRuntime({
      infer: scriptedInfer([
        { content: "a" },
        { content: "b" },
        { content: "c" },
        { content: "d" },
        { content: "e" },
      ]),
      extensions: [
        summarize({
          maxEvents: 1,
          tail: 1,
          maxFailures: 2,
          summarize: async () => {
            throw new Error("llm-down");
          },
        }),
      ],
    });

    try {
      for (let i = 0; i < 4; i++) {
        agent.send(`turn-${i}`);
        await waitForAssistantCount(agent, i + 1);
      }

      const errs = await agent.until((s) =>
        s.errors.some((e) => e.phase === "compaction-disabled") ? s.errors : null,
      );
      const summarizeErrs = errs.filter((e) => e.phase === "compaction-summarize");
      const disabledErrs = errs.filter((e) => e.phase === "compaction-disabled");
      expect(summarizeErrs.length).toBeGreaterThanOrEqual(2);
      const firstErr = summarizeErrs[0].error;
      const message = firstErr instanceof Error ? firstErr.message : "";
      expect(message).toBe("llm-down");
      expect(disabledErrs).toHaveLength(1);
      const disabled = disabledErrs[0].error;
      const disabledMessage = disabled instanceof Error ? disabled.message : "";
      expect(disabledMessage).toContain("disabled after");
    } finally {
      await agent.dispose();
    }
  });

  it("each firing appends one compaction.summary event; projection renders the boundary", async () => {
    // Event-sourced design: the watcher runs inside the managed runtime
    // so it appends directly to the log via yield*. One log event per
    // firing; the projection collapses the covered range into a single
    // system block. Hydration replays for free.
    let resolveSummary: (value: string) => void = () => {};
    let markCalled: () => void = () => {};
    const summarizerCalled = new Promise<void>((r) => {
      markCalled = r;
    });
    const summarizeFn = async (_b: Fragment[]): Promise<string> => {
      markCalled();
      return new Promise<string>((res) => {
        resolveSummary = res;
      });
    };

    const infer: InferFn = async () => ({ content: "ack" });
    const agent = createAgentRuntime({
      infer,
      extensions: [
        summarize({ maxEvents: 2, tail: 1, summarize: summarizeFn }),
      ],
    });

    try {
      await agent.send("t1");
      await waitForAssistantCount(agent, 1);
      await agent.send("t2");
      await waitForAssistantCount(agent, 2);
      await agent.send("t3");
      await waitForAssistantCount(agent, 3);

      await summarizerCalled;
      const eventCountBefore = (await agent.events()).length;
      const systemOf = (rendered: { system: string | ReadonlyArray<{ text: string }> }): string =>
        typeof rendered.system === "string"
          ? rendered.system
          : rendered.system.map((c) => c.text).join("\n\n");
      const before = await agent.rendered();
      expect(systemOf(before)).not.toMatch(/\[compacted \d+ prior turns\]/);

      resolveSummary("a concise summary");

      const compactedSys = await agent.until((s) => {
        const text = systemOf(s.rendered);
        return /\[compacted \d+ prior turns\]/.test(text) ? text : null;
      });
      expect(compactedSys).toContain("a concise summary");

      const eventsAfter = await agent.events();
      expect(eventsAfter.length).toBe(eventCountBefore + 1);
      const boundary = eventsAfter[eventsAfter.length - 1];
      expect(boundary.type).toBe("compaction.summary");
    } finally {
      resolveSummary("(unused)");
      await agent.dispose();
    }
  });

  it("agent still responds to user messages after summarize fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    let turn = 0;
    const infer: InferFn = async () => ({ content: `reply-${++turn}` });

    const agent = createAgentRuntime({
      infer,
      extensions: [
        summarize({
          maxEvents: 1,
          tail: 1,
          maxFailures: 1,
          summarize: async () => {
            throw new Error("always-fail");
          },
        }),
      ],
    });

    try {
      agent.send("first");
      await waitForAssistantCount(agent, 1);
      agent.send("second");
      await waitForAssistantCount(agent, 2);
      agent.send("third");
      await waitForAssistantCount(agent, 3);

      const events = await agent.events();
      const replies = events
        .filter((e) => e.type === "assistant.message")
        .map((e) => ("content" in e ? e.content : ""));
      expect(replies).toEqual(["reply-1", "reply-2", "reply-3"]);
    } finally {
      await agent.dispose();
    }
  });
});
