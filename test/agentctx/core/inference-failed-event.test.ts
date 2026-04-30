import { describe, expect, it } from "vitest";
import { createAgentRuntime } from "effectctx";

// Regression: when the InferFn throws, the inference loop must append a
// terminal `inference.failed` event to the log. Without this, callers
// using `agent.until((s) => ...)` to await a final message will hang
// forever — the log has no terminal-shaped event to match on, no
// `assistant.halted` lands (no extension noticed), and the public state
// is indistinguishable from "still thinking". This is the silent-hang
// failure mode every integrator hit before the event existed.
//
// Live repro: cloud-claude (effectctx-vendored AI Gateway integration,
// Apr 2026): a Vercel Gateway 500 from Anthropic ("messages: text content
// blocks must be non-empty") was caught by the inference loop's
// `Effect.catchAll`, the structured error landed on `ctx.errors`, but
// the event log had only [user.message, assistant.message{tool_call},
// tool.result] — no further events. The session sat in `running` for
// hours.

describe("agentctx: inference.failed event surfacing", () => {
  it("appends inference.failed when InferFn throws", async () => {
    const agent = createAgentRuntime({
      infer: async () => {
        throw new Error("upstream provider 500");
      },
    });
    try {
      await agent.send("hi");
      const result = await Promise.race([
        agent.until((s) => {
          const last = s.events.at(-1);
          if (!last) return null;
          if (last.type === "inference.failed")
            return { failed: last.cause };
          if (last.type === "assistant.message")
            return { unexpected: last.content };
          return null;
        }),
        new Promise<{ timeout: true }>((resolve) =>
          setTimeout(() => resolve({ timeout: true }), 2000),
        ),
      ]);
      expect(result).toEqual({ failed: "upstream provider 500" });
    } finally {
      await agent.dispose();
    }
  });

  it("does not re-fire inference after inference.failed (terminal within turn)", async () => {
    let calls = 0;
    const agent = createAgentRuntime({
      infer: async () => {
        calls++;
        throw new Error("boom");
      },
    });
    try {
      await agent.send("hi");
      await agent.until((s) => {
        const last = s.events.at(-1);
        return last?.type === "inference.failed" ? true : null;
      });
      // Wait a beat to confirm no follow-up inference fires.
      await new Promise((r) => setTimeout(r, 200));
      expect(calls).toBe(1);
    } finally {
      await agent.dispose();
    }
  });

  it("inference resumes on the next user message after a failure", async () => {
    let attempt = 0;
    const agent = createAgentRuntime({
      infer: async () => {
        attempt++;
        if (attempt === 1) throw new Error("transient");
        return { content: `ok-${attempt}` };
      },
    });
    try {
      await agent.send("first");
      await agent.until((s) => {
        const last = s.events.at(-1);
        return last?.type === "inference.failed" ? true : null;
      });
      await agent.send("retry");
      const result = await agent.until((s) => {
        const last = s.events.at(-1);
        return last?.type === "assistant.message" &&
          last.content.startsWith("ok-")
          ? { text: last.content }
          : null;
      });
      expect(result).toEqual({ text: "ok-2" });
    } finally {
      await agent.dispose();
    }
  });
});
