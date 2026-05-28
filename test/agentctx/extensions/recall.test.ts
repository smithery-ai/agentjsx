import { describe, expect, it } from "vitest";
import { createAgentRuntime, recall } from "@flamecast/agentctx";
import type { InferFn } from "@flamecast/agentctx";
import { scriptedInfer, toolCall } from "../helpers/scripted-infer";

describe("agentctx: recall extension", () => {
  it("exact-seq lookup returns the full content of the requested event", async () => {
    const big = "X".repeat(2000);
    const infer: InferFn = scriptedInfer([
      {
        // After the first user message, call `recall` to look it up.
        content: "",
        tool_calls: [toolCall("c1", "recall", { seqs: [0] })],
      },
      { content: "recalled" },
    ]);

    const agent = createAgentRuntime({
      infer,
      extensions: [recall()],
    });

    try {
      await agent.send(big);
      await agent.until((s) => {
        const last = s.events.at(-1);
        return last?.type === "assistant.message" &&
          (!last.tool_calls || last.tool_calls.length === 0)
          ? last
          : null;
      });

      const events = await agent.events();
      const toolResult = events.find((e) => e.type === "tool.result");
      if (toolResult && toolResult.type === "tool.result") {
        expect(toolResult.content).toContain("[seq 0, user.message, turn 1]");
        expect(toolResult.content).toContain(big);
      } else {
        throw new Error("no tool.result found");
      }
    } finally {
      await agent.dispose();
    }
  });

  it("filter by type returns matching events with a turn header", async () => {
    const infer: InferFn = scriptedInfer([
      { content: "reply-1" },
      { content: "reply-2" },
      {
        content: "",
        tool_calls: [toolCall("c1", "recall", { type: "assistant.message" })],
      },
      { content: "done" },
    ]);

    const agent = createAgentRuntime({
      infer,
      extensions: [recall()],
    });

    try {
      await agent.send("one");
      await agent.until(
        (s) =>
          s.events.filter((e) => e.type === "assistant.message").length >= 1
            ? true
            : null,
      );
      await agent.send("two");
      await agent.until(
        (s) =>
          s.events.filter((e) => e.type === "assistant.message").length >= 2
            ? true
            : null,
      );
      await agent.send("recall my replies");
      await agent.until((s) => {
        const last = s.events.at(-1);
        return last?.type === "assistant.message" &&
          (!last.tool_calls || last.tool_calls.length === 0)
          ? last
          : null;
      });

      const events = await agent.events();
      const recalled = events.find(
        (e) => e.type === "tool.result" && e.tool_call_id === "c1",
      );
      if (!recalled || recalled.type !== "tool.result") {
        throw new Error("no recall tool.result");
      }
      // Two replies should show up with their turn numbers.
      expect(recalled.content).toMatch(/assistant\.message, turn 1/);
      expect(recalled.content).toMatch(/assistant\.message, turn 2/);
      expect(recalled.content).toContain("reply-1");
      expect(recalled.content).toContain("reply-2");
    } finally {
      await agent.dispose();
    }
  });

  it("hideInternal drops tool.call.started and compaction.summary by default", async () => {
    const infer: InferFn = scriptedInfer([
      {
        content: "",
        tool_calls: [toolCall("c1", "noop", {})],
      },
      // After the noop tool result, read the full log.
      {
        content: "",
        tool_calls: [toolCall("c2", "recall", {})],
      },
      { content: "done" },
    ]);

    const agent = createAgentRuntime({
      infer,
      tools: [
        {
          name: "noop",
          description: "",
          parameters: { type: "object", properties: {} },
          run: async () => "ok",
        },
      ],
      extensions: [recall()],
    });

    try {
      await agent.send("go");
      await agent.until((s) => {
        const last = s.events.at(-1);
        return last?.type === "assistant.message" &&
          (!last.tool_calls || last.tool_calls.length === 0)
          ? last
          : null;
      });
      const events = await agent.events();
      const recalled = events.find(
        (e) => e.type === "tool.result" && e.tool_call_id === "c2",
      );
      if (!recalled || recalled.type !== "tool.result") {
        throw new Error("no recall tool.result");
      }
      // Internal beacons must not appear.
      expect(recalled.content).not.toContain("tool.call.started");
    } finally {
      await agent.dispose();
    }
  });

  it("exact-seq cap truncates a single recalled event at singleSeqMaxChars", async () => {
    const huge = "y".repeat(60_000); // > default 50k cap
    const infer: InferFn = scriptedInfer([
      {
        content: "",
        tool_calls: [toolCall("c1", "recall", { seqs: [0] })],
      },
      { content: "done" },
    ]);

    const agent = createAgentRuntime({
      infer,
      extensions: [recall({ singleSeqMaxChars: 10_000 })],
    });

    try {
      await agent.send(huge);
      await agent.until((s) => {
        const last = s.events.at(-1);
        return last?.type === "assistant.message" &&
          (!last.tool_calls || last.tool_calls.length === 0)
          ? last
          : null;
      });
      const events = await agent.events();
      const recalled = events.find(
        (e) => e.type === "tool.result" && e.tool_call_id === "c1",
      );
      if (!recalled || recalled.type !== "tool.result") {
        throw new Error("no recall tool.result");
      }
      expect(recalled.content).toMatch(/content truncated at 10000 chars of 60000/);
      // Header still intact.
      expect(recalled.content).toContain("[seq 0, user.message, turn 1]");
    } finally {
      await agent.dispose();
    }
  });
});
