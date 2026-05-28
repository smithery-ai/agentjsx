import { describe, expect, it } from "vitest";
import { clipMessages, createAgentRuntime } from "@flamecast/agentctx";
import { scriptedInfer } from "../helpers/scripted-infer";

describe("agentctx: clipMessages extension", () => {
  it("clips long historical blocks while preserving the last user block", async () => {
    // The user's FIRST turn will be historical by the time a second turn
    // arrives; the latest user block is preserved verbatim per default.
    const long = "x".repeat(500);
    const agent = createAgentRuntime({
      infer: scriptedInfer([
        { content: "ack" },
        { content: "ack 2" },
      ]),
      extensions: [clipMessages({ maxChars: 50 })],
    });

    try {
      agent.send(long);
      await agent.until((s) =>
        s.events.some((e) => e.type === "assistant.message") ? true : null,
      );
      agent.send("short-ask");
      await agent.until((s) => {
        const count = s.events.filter((e) => e.type === "assistant.message").length;
        return count >= 2 ? true : null;
      });

      const rendered = await agent.rendered();
      const userMsgs = rendered.messages.filter((m) => m.role === "user");
      const contentOf = (c: string | ReadonlyArray<{ text: string }>): string =>
        typeof c === "string" ? c : c.map((chunk) => chunk.text).join("\n\n");
      expect(userMsgs.length).toBe(2);
      // Oldest user message must be clipped.
      const first = contentOf(userMsgs[0].content);
      expect(first.length).toBeLessThanOrEqual(50 + "\n[truncated]".length);
      expect(first.endsWith("[truncated]")).toBe(true);
      // Most recent user message preserved verbatim.
      expect(contentOf(userMsgs[1].content)).toBe("short-ask");
    } finally {
      await agent.dispose();
    }
  });
});
