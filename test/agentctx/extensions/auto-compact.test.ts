import { describe, expect, it } from "vitest";
import { compact, createAgentRuntime } from "@flamecast/agentjsx";
import type { Fragment, InferFn } from "@flamecast/agentjsx";
import { scriptedInfer, toolCall } from "../helpers/scripted-infer";

describe("agentctx: compact extension", () => {
  it("the compact tool declares a compaction.summary event appended alongside its tool.result", async () => {
    const summaries: Array<{ blocks: Fragment[]; focusPrompt: string | null }> = [];
    const summarizeFn = async (blocks: Fragment[]): Promise<string> => {
      const focus = blocks.find(
        (b) =>
          b.tag === "core/user-message" &&
          typeof b.content === "string" &&
          b.content.startsWith("Focus for this summary:"),
      );
      summaries.push({
        blocks,
        focusPrompt: focus
          ? focus.content.replace(/^Focus for this summary: /, "")
          : null,
      });
      return "SUMMARY_TEXT";
    };

    const infer: InferFn = scriptedInfer([
      { content: "reply-1" },
      { content: "reply-2" },
      { content: "reply-3" },
      {
        content: "",
        tool_calls: [toolCall("c1", "compact", { prompt: "keep the auth bits" })],
      },
      { content: "after-compact" },
    ]);

    const agent = createAgentRuntime({
      infer,
      extensions: [compact({ summarize: summarizeFn, tail: 1 })],
    });

    try {
      await agent.run("t1");
      await agent.until((s) =>
        s.events.filter((e) => e.type === "assistant.message").length >= 1
          ? true
          : null,
      );
      await agent.run("t2");
      await agent.until((s) =>
        s.events.filter((e) => e.type === "assistant.message").length >= 2
          ? true
          : null,
      );
      await agent.run("t3");
      await agent.until((s) =>
        s.events.filter((e) => e.type === "assistant.message").length >= 3
          ? true
          : null,
      );

      await agent.run("please compact now");
      const boundary = await agent.until((s) => {
        const e = s.events.find((ev) => ev.type === "compaction.summary");
        return e ?? null;
      });

      expect(boundary.type).toBe("compaction.summary");
      if (boundary.type !== "compaction.summary") return;
      expect(boundary.prompt).toBe("keep the auth bits");
      expect(boundary.text).toBe("SUMMARY_TEXT");
      expect(boundary.fromSeq).toBe(0);

      // Focus prompt flowed through as a prepended user block.
      expect(summaries).toHaveLength(1);
      expect(summaries[0].focusPrompt).toBe("keep the auth bits");

      // Projection collapses the covered range into one compaction
      // summary, which the adapter folds into the system prefix.
      const rendered = await agent.rendered();
      const sys = typeof rendered.system === "string"
        ? rendered.system
        : rendered.system.map((c) => c.text).join("\n\n");
      expect(sys).toContain("SUMMARY_TEXT");
      expect(sys).toMatch(/\[compacted \d+ prior turns\]/);

      // tool.result lands in the same batch, AFTER the boundary event —
      // the framework appended them atomically so seq order is
      // deterministic.
      const events = await agent.events();
      const boundarySeq = events.findIndex(
        (e) => e.type === "compaction.summary",
      );
      const resultSeq = events.findIndex(
        (e) => e.type === "tool.result" && e.tool_call_id === "c1",
      );
      expect(resultSeq).toBeGreaterThan(boundarySeq);

      const toolResult = events.find(
        (e) => e.type === "tool.result" && e.tool_call_id === "c1",
      );
      if (toolResult && toolResult.type === "tool.result") {
        expect(toolResult.content).toMatch(/Compacted \d+ events/);
      }
    } finally {
      await agent.dispose();
    }
  });

  it("returns 'nothing to compact' without appending any compaction event when the range is empty", async () => {
    const summarizeFn = async (): Promise<string> => "SHOULD_NOT_FIRE";
    const infer: InferFn = scriptedInfer([
      {
        content: "",
        tool_calls: [toolCall("c1", "compact")],
      },
      { content: "after" },
    ]);

    const agent = createAgentRuntime({
      infer,
      extensions: [compact({ summarize: summarizeFn, tail: 10 })],
    });

    try {
      await agent.run("hi");
      await agent.until((s) =>
        s.events.some(
          (e) => e.type === "tool.result" && e.tool_call_id === "c1",
        )
          ? true
          : null,
      );

      const events = await agent.events();
      expect(events.some((e) => e.type === "compaction.summary")).toBe(false);

      const toolResult = events.find(
        (e) => e.type === "tool.result" && e.tool_call_id === "c1",
      );
      expect(toolResult).toBeTruthy();
      if (toolResult && toolResult.type === "tool.result") {
        expect(toolResult.content).toMatch(/Nothing to compact/);
      }
    } finally {
      await agent.dispose();
    }
  });

  it("stacks boundaries additively across multiple invocations", async () => {
    let callCount = 0;
    const summarizeFn = async (): Promise<string> => `SUMMARY_${++callCount}`;

    const infer: InferFn = scriptedInfer([
      { content: "r1" },
      { content: "r2" },
      {
        content: "",
        tool_calls: [toolCall("c1", "compact")],
      },
      { content: "mid" },
      { content: "r3" },
      {
        content: "",
        tool_calls: [toolCall("c2", "compact")],
      },
      { content: "done" },
    ]);

    const agent = createAgentRuntime({
      infer,
      extensions: [compact({ summarize: summarizeFn, tail: 1 })],
    });

    try {
      await agent.run("t1");
      await agent.until((s) =>
        s.events.filter((e) => e.type === "assistant.message").length >= 1
          ? true
          : null,
      );
      await agent.run("t2");
      await agent.until((s) =>
        s.events.filter((e) => e.type === "assistant.message").length >= 2
          ? true
          : null,
      );

      await agent.run("compact #1");
      await agent.until((s) =>
        s.events.filter((e) => e.type === "compaction.summary").length >= 1
          ? true
          : null,
      );

      await agent.run("t3");
      await agent.until((s) =>
        s.events.filter((e) => e.type === "assistant.message").length >= 4
          ? true
          : null,
      );

      await agent.run("compact #2");
      await agent.until((s) =>
        s.events.filter((e) => e.type === "compaction.summary").length >= 2
          ? true
          : null,
      );

      const events = await agent.events();
      const boundaries = events.filter((e) => e.type === "compaction.summary");
      expect(boundaries).toHaveLength(2);
      if (
        boundaries[0].type === "compaction.summary" &&
        boundaries[1].type === "compaction.summary"
      ) {
        // Second boundary picks up right after the first — disjoint,
        // additive ranges.
        expect(boundaries[1].fromSeq).toBe(boundaries[0].toSeq + 1);
      }

      const rendered = await agent.rendered();
      const sys = typeof rendered.system === "string"
        ? rendered.system
        : rendered.system.map((c) => c.text).join("\n\n");
      expect(sys).toContain("SUMMARY_1");
      expect(sys).toContain("SUMMARY_2");
      // Two compaction boundaries, each with its own "[compacted N prior turns]" header.
      const headerCount = (sys.match(/\[compacted \d+ prior turns\]/g) ?? []).length;
      expect(headerCount).toBe(2);
    } finally {
      await agent.dispose();
    }
  });
});
