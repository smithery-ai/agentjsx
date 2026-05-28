import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { AgentCtx, createAgentRuntime, maxSteps } from "@flamecast/agentjsx";
import type { InferFn, ProviderContext } from "@flamecast/agentjsx";

// Locks the current `agent.run` behavior before a planned migration adds
// slash-command routing and halt-predicate gating. Each test here pins a
// behavior that the next PR will deliberately change; when these break,
// the regression proves the new behavior shipped.

describe("agentctx: agent.run contract (pre-router, pre-halt-gating)", () => {
  it("non-slash input is appended as a user.message and fed to infer unchanged", async () => {
    let lastContext: ProviderContext | undefined;
    const infer: InferFn = async (ctx) => {
      lastContext = ctx;
      return { content: "ok" };
    };

    const agent = createAgentRuntime({ infer });
    try {
      await agent.run("hello world");

      await agent.until((s) => {
        const last = s.events.at(-1);
        return last?.type === "assistant.message" ? true : null;
      });

      expect(lastContext).toBeDefined();
      const messages = lastContext!.messages;
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      expect(lastUser).toBeDefined();
      const content = lastUser!.content;
      const text =
        typeof content === "string"
          ? content
          : content.map((c) => c.text).join("");
      expect(text).toBe("hello world");

      const events = await agent.events();
      const userIdx = events.findIndex(
        (e) => e.type === "user.message" && e.content === "hello world",
      );
      expect(userIdx).toBeGreaterThanOrEqual(0);
      const afterUser = events.slice(userIdx + 1);
      expect(
        afterUser.some(
          (e) => e.type === "assistant.message" && e.content === "ok",
        ),
      ).toBe(true);
    } finally {
      await agent.dispose();
    }
  });

  it("slash-prefixed input STILL goes to inference today (baseline before router)", async () => {
    // Today: no router intercepts `/<name>`. The string lands as a regular
    // user.message and infer is invoked with it. When the router lands,
    // this test must be updated — that update is the proof the router
    // shipped.
    let lastContext: ProviderContext | undefined;
    let inferCalls = 0;
    const infer: InferFn = async (ctx) => {
      inferCalls++;
      lastContext = ctx;
      return { content: "ok" };
    };

    const agent = createAgentRuntime({ infer });
    try {
      await agent.run("/foo bar");

      await agent.until((s) => {
        const last = s.events.at(-1);
        return last?.type === "assistant.message" ? true : null;
      });

      expect(inferCalls).toBe(1);
      expect(lastContext).toBeDefined();
      const lastUser = [...lastContext!.messages]
        .reverse()
        .find((m) => m.role === "user");
      expect(lastUser).toBeDefined();
      const content = lastUser!.content;
      const text =
        typeof content === "string"
          ? content
          : content.map((c) => c.text).join("");
      expect(text).toBe("/foo bar");

      const events = await agent.events();
      expect(
        events.some(
          (e) => e.type === "user.message" && e.content === "/foo bar",
        ),
      ).toBe(true);
    } finally {
      await agent.dispose();
    }
  });

  it("registered slash command intercepts: handler runs, original input is NOT a user.message", async () => {
    // Wire an agent whose JSX projection emits one command named `ping`.
    // The handler appends `pong: <args>` via runtime.appendUserMessage,
    // which routes through ctx.events.append (log is source of truth).
    // The original `/ping hello` must NOT itself land as a user.message.
    let inferCalls = 0;
    const infer: InferFn = async () => {
      inferCalls++;
      return { content: "ok-after-handler", tool_calls: undefined };
    };

    const agent = createAgentRuntime({
      infer,
      context: () => ({
        fragments: [],
        tools: [],
        commands: [
          {
            name: "ping",
            handler: ({ args, runtime }) => {
              runtime.appendUserMessage(`pong: ${args}`);
            },
          },
        ],
      }),
    });

    try {
      await agent.run("/ping hello");

      // Wait for the appended user.message to drive an inference reply.
      await agent.until((s) => {
        const last = s.events.at(-1);
        return last?.type === "assistant.message" &&
          last.content === "ok-after-handler"
          ? true
          : null;
      });

      const events = await agent.events();
      const userMessages = events.filter((e) => e.type === "user.message");
      // Exactly one user.message: the handler's `pong: hello`. The
      // raw `/ping hello` string must NOT appear.
      expect(userMessages.length).toBe(1);
      expect(
        userMessages.some(
          (e) => e.type === "user.message" && e.content === "pong: hello",
        ),
      ).toBe(true);
      expect(
        userMessages.some(
          (e) => e.type === "user.message" && e.content === "/ping hello",
        ),
      ).toBe(false);
      expect(inferCalls).toBe(1);
    } finally {
      await agent.dispose();
    }
  });

  it("assistant.halted is terminal without predicates: no further inference, no auto user.message", async () => {
    // Stub returns a plain assistant message with no tool calls. The
    // natural terminal is `assistant.message`; once it lands, no further
    // inference fires and no user.message is appended automatically.
    // When halt-predicate gating ships, an *absent* predicate must
    // preserve this exact behavior — this test pins the baseline.
    let inferCalls = 0;
    const infer: InferFn = async () => {
      inferCalls++;
      return { content: "done", tool_calls: undefined };
    };

    const agent = createAgentRuntime({ infer });
    try {
      await agent.run("hi");

      await agent.until((s) => {
        const last = s.events.at(-1);
        return last?.type === "assistant.message" && last.content === "done"
          ? true
          : null;
      });

      // Settle window: if a follow-up inference or auto user.message
      // were going to fire, it would happen within this window.
      await new Promise((r) => setTimeout(r, 200));

      const events = await agent.events();
      const last = events.at(-1);
      expect(last?.type).toBe("assistant.message");

      // Exactly one user.message — the one we sent.
      const userMessages = events.filter((e) => e.type === "user.message");
      expect(userMessages.length).toBe(1);
      expect(inferCalls).toBe(1);
    } finally {
      await agent.dispose();
    }
  });

  it("halt-gate reprompts when a predicate returns ok=false", async () => {
    // Stub infer always returns a plain assistant message (no tool calls).
    // Each call therefore produces an `assistant.halted`. With a predicate
    // registered that returns ok=false, the gate must append a synthetic
    // user.message whose content includes the predicate's reason — which
    // re-drives inference. After clearing the predicate, the next halt
    // must be terminal.
    let inferCalls = 0;
    const infer: InferFn = async () => {
      inferCalls++;
      return { content: "done", tool_calls: undefined };
    };

    // maxSteps(1) makes the first assistant.message append a halt — the
    // shape the gate is supposed to handle. Without it, content-only
    // replies never produce an `assistant.halted` event.
    const agent = createAgentRuntime({ infer, extensions: [maxSteps(1)] });
    try {
      // Reach into AgentCtx via the runtime escape hatch to register a
      // predicate without going through the slash-command path.
      let predicateCalls = 0;
      await agent.runtime.runPromise(
        Effect.gen(function* () {
          const ctx = yield* AgentCtx;
          yield* ctx.registerHaltPredicate("test", () => {
            predicateCalls++;
            // Fail the first halt; let subsequent halts stand so the
            // test reliably terminates instead of looping forever.
            return Promise.resolve(
              predicateCalls === 1
                ? { ok: false, reason: "not yet" }
                : { ok: true, reason: "satisfied" },
            );
          });
        }),
      );

      await agent.run("hi");

      // Wait until the gate's synthetic user.message lands in the log.
      await agent.until((s) => {
        const reprompt = s.events.find(
          (e) =>
            e.type === "user.message" &&
            typeof e.content === "string" &&
            e.content.includes("not yet"),
        );
        return reprompt ? true : null;
      });

      let events = await agent.events();
      const userMessages = events.filter((e) => e.type === "user.message");
      // Original "hi" plus the gate's reprompt.
      expect(userMessages.length).toBeGreaterThanOrEqual(2);
      expect(
        userMessages.some(
          (e) =>
            e.type === "user.message" &&
            typeof e.content === "string" &&
            e.content === "[goal: test] not met: not yet",
        ),
      ).toBe(true);
      // Inference fired at least twice: original + reprompt-driven turn.
      expect(inferCalls).toBeGreaterThanOrEqual(2);

      // Clear the predicate. The next halt should be terminal.
      await agent.runtime.runPromise(
        Effect.gen(function* () {
          const ctx = yield* AgentCtx;
          yield* ctx.clearHaltPredicate("test");
        }),
      );

      const callsBefore = inferCalls;
      await agent.run("again");
      // With maxSteps(1) still active and the predicate cleared, the
      // first assistant.message of the new turn drives a halt that
      // must stand — the gate is a no-op now.
      await agent.until((s) => {
        const last = s.events.at(-1);
        return last?.type === "assistant.halted" ? true : null;
      });
      // Settle: if the gate were still reprompting, another inference
      // and synthetic user.message would land within this window.
      await new Promise((r) => setTimeout(r, 200));

      events = await agent.events();
      const last = events.at(-1);
      expect(last?.type).toBe("assistant.halted");
      // No new synthetic reprompt after clearing — only "again" added.
      const newUserMessages = events
        .filter((e) => e.type === "user.message")
        .slice(userMessages.length);
      expect(newUserMessages.length).toBe(1);
      expect(
        newUserMessages[0]!.type === "user.message" &&
          newUserMessages[0]!.content === "again",
      ).toBe(true);
      // Exactly one more inference for the "again" turn — no reprompt
      // amplification after the predicate was cleared.
      expect(inferCalls).toBe(callsBefore + 1);
    } finally {
      await agent.dispose();
    }
  });
});
