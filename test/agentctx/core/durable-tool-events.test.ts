import { describe, expect, it } from "vitest";
import {
  createAgentRuntime,
  reconcileHydrationDangling,
} from "@flamecast/agentjsx";
import type { Event, Tool } from "@flamecast/agentjsx";
import { scriptedInfer, toolCall } from "../helpers/scripted-infer";

describe("agentctx: durable tool events / hydration fidelity", () => {
  it("reconcile is identity on an empty log", () => {
    expect(reconcileHydrationDangling([])).toEqual([]);
  });

  it("reconcile is idempotent on an already-resolved log", () => {
    const events: Event[] = [
      { seq: 0, type: "user.message", content: "go" },
      { seq: 1, type: "tool.call.started", tool_call_id: "c1", tool_name: "a" },
      { seq: 2, type: "tool.result", tool_call_id: "c1", content: "ok" },
    ];
    const once = reconcileHydrationDangling(events);
    expect(once.length).toBe(events.length);
    const twice = reconcileHydrationDangling(once);
    expect(twice).toEqual(once);
  });

  it("synthesizes interrupted result for dangling started-event", () => {
    const events: Event[] = [
      { seq: 0, type: "user.message", content: "go" },
      {
        seq: 1,
        type: "assistant.message",
        content: "",
        tool_calls: [toolCall("c1", "send_message", { to: "channel" })],
      },
      { seq: 2, type: "tool.call.started", tool_call_id: "c1", tool_name: "send_message" },
    ];
    const reconciled = reconcileHydrationDangling(events);
    expect(reconciled.length).toBe(events.length + 1);
    const synth = reconciled.at(-1);
    expect(synth).toMatchObject({
      type: "tool.result",
      tool_call_id: "c1",
    });
    if (synth?.type === "tool.result") {
      expect(synth.content).toContain("[interrupted:");
    }
  });

  it("synthesizes interrupted result for assistant.message(tool_calls) with no matching started", () => {
    const events: Event[] = [
      { seq: 0, type: "user.message", content: "go" },
      {
        seq: 1,
        type: "assistant.message",
        content: "",
        tool_calls: [toolCall("c1", "a", {})],
      },
    ];
    const reconciled = reconcileHydrationDangling(events);
    expect(reconciled.length).toBe(events.length + 1);
    expect(reconciled.at(-1)).toMatchObject({
      type: "tool.result",
      tool_call_id: "c1",
    });
  });

  it("handles multiple dangling ids, preserves landed results, no duplicates", () => {
    const events: Event[] = [
      { seq: 0, type: "user.message", content: "go" },
      {
        seq: 1,
        type: "assistant.message",
        content: "",
        tool_calls: [
          toolCall("c1", "a", {}),
          toolCall("c2", "b", {}),
          toolCall("c3", "c", {}),
        ],
      },
      { seq: 2, type: "tool.call.started", tool_call_id: "c1", tool_name: "a" },
      { seq: 3, type: "tool.call.started", tool_call_id: "c2", tool_name: "b" },
      { seq: 4, type: "tool.call.started", tool_call_id: "c3", tool_name: "c" },
      { seq: 5, type: "tool.result", tool_call_id: "c2", content: "b-ok" },
    ];
    const reconciled = reconcileHydrationDangling(events);
    // Two synthetic rows added: c1 and c3. c2 already resolved.
    expect(reconciled.length).toBe(events.length + 2);

    const byId = new Map<string, string>();
    for (const e of reconciled) {
      if (e.type === "tool.result") byId.set(e.tool_call_id, e.content);
    }
    expect(byId.get("c2")).toBe("b-ok");
    expect(byId.get("c1")).toContain("[interrupted:");
    expect(byId.get("c3")).toContain("[interrupted:");
    expect(byId.size).toBe(3);
  });

  it("agent constructed with a dangling log exposes the reconciled events via agent.events()", async () => {
    // Invariant: hydration reconciliation must be observable through the
    // runtime — not just the pure helper. Otherwise a crash-recovered
    // runtime would stall waiting on a result that never comes.
    const dangling: Event[] = [
      { seq: 0, type: "user.message", content: "go" },
      {
        seq: 1,
        type: "assistant.message",
        content: "",
        tool_calls: [toolCall("c1", "send", {})],
      },
      { seq: 2, type: "tool.call.started", tool_call_id: "c1", tool_name: "send" },
    ];

    // Agent will try to infer after seeing the synthetic tool.result land.
    // Script a terminal reply so the run settles.
    const agent = createAgentRuntime({
      infer: scriptedInfer([{ content: "done" }]),
      initialEvents: dangling,
    });
    try {
      const final = await agent.until((s) => {
        const last = s.events.at(-1);
        if (last?.type === "assistant.message" && !last.tool_calls) return last;
        return null;
      });
      expect(final.content).toBe("done");

      const events = await agent.events();
      const pureReconciled = reconcileHydrationDangling(dangling);
      // The prefix of the live log must match the pure reconciliation.
      for (let i = 0; i < pureReconciled.length; i++) {
        expect(events[i]).toMatchObject({
          type: pureReconciled[i].type,
          seq: pureReconciled[i].seq,
        });
      }
      // Reconciler added exactly one synthetic tool.result for c1.
      const synthResult = events.find(
        (e) => e.type === "tool.result" && e.tool_call_id === "c1",
      );
      expect(synthResult).toBeDefined();
      if (synthResult?.type === "tool.result") {
        expect(synthResult.content).toContain("[interrupted:");
      }
    } finally {
      await agent.dispose();
    }
  });

  it("round-trips a live tool dance and rehydrates without synthetic rows", async () => {
    // Run a full turn (user → assistant(tool_calls) → started → result →
    // assistant(final)), capture the durable events, and confirm that
    // passing them into a fresh agent is reconcile-identity.
    const ping: Tool = {
      name: "ping",
      description: "echoes pong",
      parameters: { type: "object" },
      run: async () => "pong",
    };

    const live = createAgentRuntime({
      infer: scriptedInfer([
        { content: "", tool_calls: [toolCall("c1", "ping", {})] },
        { content: "done" },
      ]),
      tools: [ping],
    });
    let persisted: ReadonlyArray<Event>;
    try {
      live.send("go");
      await live.until((s) => {
        const last = s.events.at(-1);
        return last?.type === "assistant.message" && !last.tool_calls ? last : null;
      });
      persisted = await live.events();
    } finally {
      await live.dispose();
    }

    // Pure: reconciliation on a fully-resolved log is identity.
    const reconciled = reconcileHydrationDangling(persisted);
    expect(reconciled.length).toBe(persisted.length);

    // Runtime: a fresh agent seeded with `persisted` must expose the same
    // events prefix. No inference is scripted because no trigger event is
    // the tail (tail is assistant.message with no tool_calls).
    const hydrated = createAgentRuntime({
      infer: scriptedInfer([]),
      initialEvents: [...persisted],
    });
    try {
      const observed = await hydrated.events();
      expect(observed.map((e) => e.type)).toEqual(persisted.map((e) => e.type));
    } finally {
      await hydrated.dispose();
    }
  });
});
