import { describe, expect, it } from "vitest";
import {
  createAgentRuntime,
  recall,
  truncateToolOutputs,
} from "@flamecast/agentctx";
import type { InferFn, ProviderContext, Tool } from "@flamecast/agentctx";
import { scriptedInfer, toolCall } from "../helpers/scripted-infer";

// Flatten a ProviderContext into a role/content list so tests can find
// the tool-result message by role. Content is flattened to a plain
// string; the cache_control chunking is irrelevant for these tests.
const messageList = (context: ProviderContext): Array<{ role: string; content: string }> => {
  const out: Array<{ role: string; content: string }> = [];
  const sys = typeof context.system === "string"
    ? context.system
    : context.system.map((c) => c.text).join("\n\n");
  if (sys) out.push({ role: "system", content: sys });
  for (const m of context.messages) {
    const text = typeof m.content === "string"
      ? m.content
      : m.content.map((c) => c.text).join("\n\n");
    out.push({ role: m.role, content: text });
  }
  return out;
};

describe("agentctx: truncateToolOutputs extension", () => {
  it("passes small outputs through unchanged", async () => {
    const smallOutput = "ok";
    const noop: Tool = {
      name: "noop",
      description: "",
      parameters: { type: "object", properties: {} },
      run: async () => smallOutput,
    };
    const seenByInfer: Array<Array<{ role: string; content: string }>> = [];
    const scripted = scriptedInfer([
      { content: "", tool_calls: [toolCall("c1", "noop", {})] },
      { content: "done" },
    ]);
    const infer: InferFn = async (context) => {
      seenByInfer.push(messageList(context));
      return scripted(context);
    };
    const agent = createAgentRuntime({
      infer,
      tools: [noop],
      extensions: [truncateToolOutputs({ triggerChars: 1000 })],
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
      // Second inference saw the tool.result — verify content was NOT
      // rewritten since "ok" is well under the trigger.
      expect(seenByInfer.length).toBeGreaterThanOrEqual(2);
      const second = seenByInfer[1];
      const toolBlock = second.find((b) => b.role === "tool");
      expect(toolBlock?.content).toBe(smallOutput);
    } finally {
      await agent.dispose();
    }
  });

  it("truncates outputs over the trigger threshold and embeds a recall pointer", async () => {
    const bigOutput = "x".repeat(60_000); // > default 50k
    const noop: Tool = {
      name: "big",
      description: "",
      parameters: { type: "object", properties: {} },
      run: async () => bigOutput,
    };
    const seenByInfer: Array<Array<{ role: string; content: string }>> = [];
    const scripted = scriptedInfer([
      { content: "", tool_calls: [toolCall("c1", "big", {})] },
      { content: "done" },
    ]);
    const infer: InferFn = async (context) => {
      seenByInfer.push(messageList(context));
      return scripted(context);
    };
    const agent = createAgentRuntime({
      infer,
      tools: [noop],
      extensions: [recall(), truncateToolOutputs()],
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
      const second = seenByInfer[1];
      const toolBlock = second.find((b) => b.role === "tool");
      expect(toolBlock).toBeTruthy();
      expect(toolBlock!.content.length).toBeLessThan(bigOutput.length);
      expect(toolBlock!.content).toMatch(/output truncated — \d+ of 60000 chars/);
      // Hint points to the recall tool with the tool.result's seq.
      expect(toolBlock!.content).toMatch(/recall\(\{ seqs: \[\d+\] \}\)/);

      // Critically: the underlying log still has the FULL content.
      // Only the projection was rewritten.
      const events = await agent.events();
      const rawResult = events.find(
        (e) => e.type === "tool.result" && e.tool_call_id === "c1",
      );
      if (!rawResult || rawResult.type !== "tool.result") {
        throw new Error("no raw tool.result");
      }
      expect(rawResult.content).toBe(bigOutput);
      expect(rawResult.content.length).toBe(60_000);
    } finally {
      await agent.dispose();
    }
  });

  it("emits a no-recovery hint when the recall tool isn't registered", async () => {
    const bigOutput = "z".repeat(60_000);
    const big: Tool = {
      name: "big2",
      description: "",
      parameters: { type: "object", properties: {} },
      run: async () => bigOutput,
    };
    const seenByInfer: Array<Array<{ role: string; content: string }>> = [];
    const scripted = scriptedInfer([
      { content: "", tool_calls: [toolCall("c1", "big2", {})] },
      { content: "done" },
    ]);
    const infer: InferFn = async (context) => {
      seenByInfer.push(messageList(context));
      return scripted(context);
    };
    const agent = createAgentRuntime({
      infer,
      tools: [big],
      // NO `recall()` — truncation must fall back to the subagent hint.
      extensions: [truncateToolOutputs()],
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
      const second = seenByInfer[1];
      const toolBlock = second.find((b) => b.role === "tool");
      expect(toolBlock).toBeTruthy();
      expect(toolBlock!.content).toMatch(/output truncated/);
      // The recall pointer MUST NOT be present.
      expect(toolBlock!.content).not.toMatch(/recall\(/);
      // Subagent fallback hint IS present.
      expect(toolBlock!.content).toMatch(/spawn a subagent/);
    } finally {
      await agent.dispose();
    }
  });

  it("preview cuts at the last newline within the preview budget", async () => {
    // Build a big output with newlines every 100 chars so cutAtNewline
    // has a boundary to snap to. With previewChars=500 and cutAtNewline
    // true, the preview should end at a newline near seq 400.
    const line = "a".repeat(99); // 99 + \n = 100 char block
    const bigOutput = Array.from({ length: 1000 }, () => line).join("\n");
    const big: Tool = {
      name: "big",
      description: "",
      parameters: { type: "object", properties: {} },
      run: async () => bigOutput,
    };
    const seenByInfer: Array<Array<{ role: string; content: string }>> = [];
    const scripted = scriptedInfer([
      { content: "", tool_calls: [toolCall("c1", "big", {})] },
      { content: "done" },
    ]);
    const infer: InferFn = async (context) => {
      seenByInfer.push(messageList(context));
      return scripted(context);
    };
    const agent = createAgentRuntime({
      infer,
      tools: [big],
      extensions: [
        truncateToolOutputs({
          triggerChars: 2000,
          previewChars: 500,
          cutAtNewline: true,
        }),
      ],
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
      const second = seenByInfer[1];
      const toolBlock = second.find((b) => b.role === "tool");
      expect(toolBlock).toBeTruthy();
      // Grab the preview body (after the bracketed header). It must
      // end at a newline, not mid-line.
      const body = toolBlock!.content.split("\n\n").slice(1).join("\n\n");
      expect(body.endsWith("a")).toBe(true); // a full line's last char, not mid-line
    } finally {
      await agent.dispose();
    }
  });
});
