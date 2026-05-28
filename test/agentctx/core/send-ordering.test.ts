import { describe, expect, it } from "vitest";
import { createAgentRuntime } from "@flamecast/agentctx";
import { scriptedInfer } from "../helpers/scripted-infer";

// Regression: `agent.send(content)` must resolve only after the user.message
// is durably in the log. A fire-and-forget send (send returning `void`)
// caused an off-by-one in interactive consumers: a caller that did
//
//    agent.send(line)
//    await agent.until(s => isTerminal(s.events.at(-1)) ? true : null)
//
// saw `until` resolve immediately on the initial SubscriptionRef replay,
// which surfaced the PREVIOUS turn's already-terminal assistant.message
// before the current turn's user.message had been appended. The result was
// that each turn's REPL output showed the previous turn's reply. The fix:
// `send` returns `Promise<void>` that resolves after the append has landed.

describe("agentctx: send ordering", () => {
  it("await send resolves only after user.message is in the log", async () => {
    const agent = createAgentRuntime({
      infer: scriptedInfer([{ content: "hi" }]),
    });
    try {
      const before = (await agent.events()).length;
      await agent.send("hello");
      const after = await agent.events();
      // The user.message must be present at its expected slot. The
      // assistant.message may or may not have landed yet — that depends
      // on inference timing — but the send's own append is durable at
      // the moment `await send` resolves, which is the invariant we care
      // about here.
      expect(after.length).toBeGreaterThanOrEqual(before + 1);
      expect(after[before]).toMatchObject({
        type: "user.message",
        content: "hello",
      });
    } finally {
      await agent.dispose();
    }
  });

  it("await send then await until resolves on the CURRENT turn's reply, not the prior one", async () => {
    const agent = createAgentRuntime({
      infer: scriptedInfer([{ content: "first" }, { content: "second" }]),
    });
    try {
      // Turn 1: establishes a terminal assistant.message in the log.
      await agent.send("one");
      const first = await agent.until((s) => {
        const last = s.events.at(-1);
        return last?.type === "assistant.message" && last.content === "first"
          ? last.content
          : null;
      });
      expect(first).toBe("first");

      // Turn 2: with the prior turn already terminal, a fire-and-forget
      // send would let `until` resolve on the stale "first" reply via
      // SubscriptionRef.changes' initial replay. Awaiting send guarantees
      // the new user.message is in the log before `until` subscribes, so
      // the only terminal state that satisfies the predicate is the new
      // "second" reply.
      await agent.send("two");
      const second = await agent.until((s) => {
        const last = s.events.at(-1);
        if (last?.type !== "assistant.message") return null;
        return last.content;
      });
      expect(second).toBe("second");
    } finally {
      await agent.dispose();
    }
  });
});
