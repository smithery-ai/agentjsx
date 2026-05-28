import { describe, expect, it } from "vitest";
import { createAgentRuntime } from "@flamecast/agentjsx";
import type { InferFn, InferResponse } from "@flamecast/agentjsx";

// Regression: inference must read a ProviderContext that is consistent
// with the log state it triggers on.
//
// The original runtime had two forked fibers subscribed to `log.changes`:
// (1) the projection fiber that maintains `ctx.rendered` and (2) the
// inference fiber that reads `ctx.rendered` to build its prompt. When the
// log emitted, both were notified concurrently with no ordering
// guarantee, so inference would sometimes run on the new log state but
// with the PRE-append materialized blocks — producing a reply that
// actually belonged to the previous turn. Live repro against the AI Gateway path
// showed:
//
//   > hey       → "Got it. Thanks for the context!"
//   > 2+2?      → "Hey! What can I do for you?"    (the reply to "hey")
//   > yo        → "2 + 2 = 4"                       (the reply to "2+2?")
//
// Fix: inference calls `ctx.render` — an Effect that derives
// blocks inline from the log + blockSources + transforms — rather than
// reading the materialized `ctx.rendered` ref. The projected blocks are
// therefore guaranteed consistent with the log snapshot that triggered
// the step.

describe("agentctx: inference/projection consistency", () => {
  it("inference sees user.message from the turn it is responding to", async () => {
    const observed: Array<ReadonlyArray<string>> = [];
    const infer: InferFn = async (context): Promise<InferResponse> => {
      observed.push(
        context.messages
          .filter((m) => m.role === "user")
          .map((m) => (typeof m.content === "string" ? m.content : m.content.map((c) => c.text).join(""))),
      );
      return { content: `seen=${observed.length}` };
    };

    const agent = createAgentRuntime({ infer });
    try {
      await agent.run("one");
      await agent.until((s) => {
        const last = s.events.at(-1);
        return last?.type === "assistant.message" && last.content === "seen=1"
          ? true
          : null;
      });

      await agent.run("two");
      await agent.until((s) => {
        const last = s.events.at(-1);
        return last?.type === "assistant.message" && last.content === "seen=2"
          ? true
          : null;
      });

      expect(observed).toEqual([["one"], ["one", "two"]]);
    } finally {
      await agent.dispose();
    }
  });
});
