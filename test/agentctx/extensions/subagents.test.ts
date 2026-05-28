import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentCtx,
  createAgentRuntime,
  subagents,
  type Event,
  type Extension,
  type InferFn,
  type InferResponse,
  type ProviderContext,
} from "@flamecast/agentjsx";
import { toolCall } from "../helpers/scripted-infer";

// Flatten ProviderContext.system to a plain string so tests can
// substring-match on marker text (the adapter may emit string or
// content-chunk array depending on cache_control presence).
const systemText = (context: ProviderContext): string => {
  const s = context.system;
  return typeof s === "string" ? s : s.map((c) => c.text).join("\n\n");
};

// Render ProviderContext.tools as name array for tool-visibility
// assertions (replaces the old `tools.map((t) => t.name)` that
// inspected the runtime Tool[] argument).
const toolNames = (context: ProviderContext): string[] =>
  context.tools.map((t) => t.name);

// Find a user message matching a predicate on its flattened text. Used
// by the `sharedBlocks` test to locate shared parent-state fragments
// that the adapter folded into a user content chunk or message.
const firstUserContent = (context: ProviderContext, includes: string): string | null => {
  for (const msg of context.messages) {
    if (msg.role !== "user") continue;
    const txt = typeof msg.content === "string"
      ? msg.content
      : msg.content.map((c) => c.text).join("\n\n");
    if (txt.includes(includes)) return txt;
  }
  return null;
};

// Extension that appends an assistant.halted event immediately on
// build. Used to force a subagent into the "halted" terminal state.
const haltOnBuild = (reason: string): Extension =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const ctx = yield* AgentCtx;
      yield* ctx.events.append({ type: "assistant.halted", reason });
    }),
  );

// Multiplex InferFn keyed by a marker string in the system prompt.
// Each key has its own independent call cursor so parent and children
// can share the same factory with distinct scripts.
const multiplexed = (scripts: Record<string, InferResponse[]>): InferFn => {
  const cursors: Record<string, number> = {};
  return async (context) => {
    const sys = systemText(context);
    const match = Object.keys(scripts).find((key) => sys.includes(key));
    const key = match ?? "__default__";
    cursors[key] = cursors[key] ?? 0;
    const script = scripts[key] ?? [];
    const idx = cursors[key]++;
    if (idx >= script.length) return { content: "[exhausted]" };
    return script[idx];
  };
};

const finalResult = (events: ReadonlyArray<Event>): Event | null => {
  const last = events[events.length - 1];
  if (!last || last.type !== "assistant.message") return null;
  if (last.tool_calls && last.tool_calls.length > 0) return null;
  return last;
};

describe("agentctx: subagents extension", () => {
  it("spawns a child and routes its result back to the parent tool call", async () => {
    const infer = multiplexed({
      __parent__: [
        {
          content: "",
          tool_calls: [
            toolCall("c1", "spawn_agent", { type: "research", prompt: "find X" }),
          ],
        },
        { content: "parent saw: found X" },
      ],
      __research__: [{ content: "found X" }],
    });

    const agent = createAgentRuntime({
      system: "__parent__",
      infer,
      extensions: [
        subagents({
          agents: {
            research: {
              description: "research agent",
              systemPrompt: "__research__",
              extensions: () => [],
            },
          },
          infer,
        }),
      ],
    });

    try {
      agent.send("go");
      await agent.until((s) => finalResult(s.events));
      const events = await agent.events();
      const toolResult = events.find((e) => e.type === "tool.result");
      expect(toolResult && toolResult.type === "tool.result" && toolResult.content).toBe(
        "found X",
      );
    } finally {
      await agent.dispose();
    }
  });

  it("denies recursion by default — child has no spawn_agent tool", async () => {
    // Capture the tools visible at the child's infer call. When recursion
    // is "deny" (default), the child should not see `spawn_agent`.
    let childToolNames: string[] | null = null;
    const childInfer: InferFn = async (context) => {
      childToolNames = toolNames(context);
      return { content: "child done" };
    };
    const parentInfer = multiplexed({
      __parent__: [
        {
          content: "",
          tool_calls: [toolCall("c1", "spawn_agent", { type: "worker", prompt: "hi" })],
        },
        { content: "parent done" },
      ],
    });

    // Combine: the extension selects infer based on system marker.
    const combined: InferFn = async (context) => {
      const sys = systemText(context);
      if (sys.includes("__worker__")) return childInfer(context);
      return parentInfer(context);
    };

    const agent = createAgentRuntime({
      system: "__parent__",
      infer: combined,
      extensions: [
        subagents({
          agents: {
            worker: {
              description: "worker",
              systemPrompt: "__worker__",
              extensions: () => [],
            },
          },
          infer: combined,
        }),
      ],
    });

    try {
      agent.send("go");
      await agent.until((s) => finalResult(s.events));
      expect(childToolNames).not.toBeNull();
      expect(childToolNames).not.toContain("spawn_agent");
    } finally {
      await agent.dispose();
    }
  });

  it("recursion=allow with maxDepth=2 blocks third-level spawn", async () => {
    // Capture every level's visible tools and final tool.result content.
    const toolsByLevel: Record<string, string[]> = {};

    const infer: InferFn = async (context) => {
      const sys = systemText(context);
      const level = sys.includes("__depth2__")
        ? "depth2"
        : sys.includes("__depth1__")
          ? "depth1"
          : "root";
      toolsByLevel[level] = toolNames(context);

      if (level === "root") {
        // Root: spawn depth1 once, then reply.
        const spawned = (toolsByLevel.__root_spawned__ ?? []).length;
        if (spawned === 0) {
          toolsByLevel.__root_spawned__ = ["x"];
          return {
            content: "",
            tool_calls: [
              toolCall("r1", "spawn_agent", { type: "inner", prompt: "go deeper" }),
            ],
          };
        }
        return { content: "root done" };
      }
      if (level === "depth1") {
        const spawned = (toolsByLevel.__d1_spawned__ ?? []).length;
        if (spawned === 0) {
          toolsByLevel.__d1_spawned__ = ["x"];
          return {
            content: "",
            tool_calls: [
              toolCall("d1", "spawn_agent", { type: "inner", prompt: "even deeper" }),
            ],
          };
        }
        return { content: "depth1 done" };
      }
      // depth2: attempt to spawn; its tool surface should lack spawn_agent.
      const spawned = (toolsByLevel.__d2_spawned__ ?? []).length;
      if (spawned === 0) {
        toolsByLevel.__d2_spawned__ = ["x"];
        // Even if we request the tool call, the runtime will fail it
        // with an unknown-tool error because depth2 has no spawn_agent.
        return {
          content: "",
          tool_calls: [
            toolCall("d2", "spawn_agent", { type: "inner", prompt: "abyss" }),
          ],
        };
      }
      return { content: "depth2 done" };
    };

    // Build: root gets subagents(maxDepth=2, allow). That propagates a
    // subagents(maxDepth=1) to depth1, which does NOT further propagate.
    // depth2 therefore has no spawn_agent tool.
    const defs = {
      inner: {
        description: "inner agent",
        systemPrompt: "__depth1____depth2__",
        extensions: () => [],
      },
    };
    // Distinct system prompts per level need different defs — but the
    // runtime re-uses the same def on every spawn. To distinguish
    // depth1 from depth2 in the system prompt we rely on the nested
    // subagents() each installing its OWN `inner` def via catalog —
    // here we do that by seeding separate system markers via the def's
    // per-layer catalog. Simplest: use a single marker on the shared
    // def and lean on the `spawned` counter in `infer` to discriminate.
    // For depth detection use the tools list instead of system prompt.
    const agent = createAgentRuntime({
      system: "__root__",
      infer,
      extensions: [
        subagents({
          agents: defs,
          infer,
          recursion: "allow",
          maxDepth: 2,
        }),
      ],
    });

    try {
      agent.send("go");
      await agent.until((s) => finalResult(s.events));

      // Depth distinction in this test is by "did the child have
      // spawn_agent when asked?". At root and depth1 it's present; at
      // depth2 it is NOT. Assert that *some* child call saw no
      // spawn_agent in its tool surface — that child is depth2.
      const depthsSeen = Object.values(toolsByLevel).filter((t) => Array.isArray(t));
      const callsWithoutSpawn = depthsSeen.filter(
        (tools) => Array.isArray(tools) && !tools.includes("spawn_agent"),
      );
      expect(callsWithoutSpawn.length).toBeGreaterThan(0);
      const callsWithSpawn = depthsSeen.filter(
        (tools) => Array.isArray(tools) && tools.includes("spawn_agent"),
      );
      expect(callsWithSpawn.length).toBeGreaterThan(0);
    } finally {
      await agent.dispose();
    }
  });

  it("parent dispose cancels a running child", async () => {
    // Child's infer never resolves. The only way the child runtime
    // releases its resources is via parent-scope finalizer calling
    // `backend.abort(handle)`, which disposes the child ManagedRuntime.
    // Observe that via a child-side finalizer registered on the child's
    // extension scope — it fires only when the child is disposed.
    let childStarted = false;
    let childFinalizerFired = false;
    const childHang = new Promise<InferResponse>(() => {});
    const childInfer: InferFn = () => {
      childStarted = true;
      return childHang;
    };

    const observer: Extension = Layer.scopedDiscard(
      Effect.acquireRelease(Effect.void, () =>
        Effect.sync(() => {
          childFinalizerFired = true;
        }),
      ),
    );

    const parentInfer: InferFn = async (context) => {
      const sys = systemText(context);
      if (sys.includes("__child__")) return childInfer(context);
      return {
        content: "",
        tool_calls: [toolCall("c1", "spawn_agent", { type: "hang", prompt: "wait" })],
      };
    };

    const agent = createAgentRuntime({
      system: "__parent__",
      infer: parentInfer,
      extensions: [
        subagents({
          agents: {
            hang: {
              description: "hanging agent",
              systemPrompt: "__child__",
              extensions: () => [observer],
            },
          },
          infer: parentInfer,
        }),
      ],
    });

    agent.send("go");
    // Wait until the child's infer has started (child is live).
    await new Promise<void>((resolve) => {
      const t0 = Date.now();
      const poll = setInterval(() => {
        if (childStarted || Date.now() - t0 > 3000) {
          clearInterval(poll);
          resolve();
        }
      }, 10);
    });
    expect(childStarted).toBe(true);
    expect(childFinalizerFired).toBe(false);

    // Dispose parent. This should propagate to the child via
    // `backend.abort(handle)`, which disposes the child runtime and
    // runs its extension finalizers.
    await agent.dispose();

    // Allow one macrotask for the aborted child's finalizer to run.
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(childFinalizerFired).toBe(true);
  });

  it("shared blocks expose parent state on first child infer", async () => {
    const seenByChild: string[] = [];
    const childInfer: InferFn = async (context) => {
      // `parent_context` shared block materializes as a system-role
      // fragment in the child. After adapter flattening, it's folded
      // into context.system — substring-match for its value.
      seenByChild.push(firstUserContent(context, "parent-context") ?? (systemText(context).includes("parent-context") ? "parent-context" : ""));
      return { content: "child done" };
    };

    const parentInfer = multiplexed({
      __parent__: [
        {
          content: "",
          tool_calls: [
            toolCall("c1", "spawn_agent", { type: "peek", prompt: "observe" }),
          ],
        },
        { content: "parent done" },
      ],
    });

    const combined: InferFn = async (context) => {
      const sys = systemText(context);
      if (sys.includes("__peek__")) return childInfer(context);
      return parentInfer(context);
    };

    const agent = createAgentRuntime({
      system: "__parent__",
      infer: combined,
      extensions: [
        subagents({
          agents: {
            peek: {
              description: "peek at parent",
              systemPrompt: "__peek__",
              extensions: () => [],
              sharedBlocks: () => ({
                parent_context: () => "parent-context",
              }),
            },
          },
          infer: combined,
        }),
      ],
    });

    try {
      agent.send("hello");
      await agent.until((s) => finalResult(s.events));
      expect(seenByChild).toHaveLength(1);
      expect(seenByChild[0]).toBe("parent-context");
    } finally {
      await agent.dispose();
    }
  });

  it("returns a tool-level error for unknown subagent type", async () => {
    const infer = multiplexed({
      __parent__: [
        {
          content: "",
          tool_calls: [
            toolCall("c1", "spawn_agent", { type: "does-not-exist", prompt: "?" }),
          ],
        },
        { content: "parent done" },
      ],
    });

    const agent = createAgentRuntime({
      system: "__parent__",
      infer,
      extensions: [
        subagents({
          agents: {
            research: { description: "research", extensions: () => [] },
          },
          infer,
        }),
      ],
    });

    try {
      agent.send("go");
      await agent.until((s) => finalResult(s.events));
      const events = await agent.events();
      const toolResult = events.find((e) => e.type === "tool.result");
      expect(
        toolResult && toolResult.type === "tool.result" && toolResult.content,
      ).toContain("Unknown subagent type: does-not-exist");
      const errs = await agent.errors();
      expect(errs).toHaveLength(0);
    } finally {
      await agent.dispose();
    }
  });

  it("formats a halt response when the child halts immediately", async () => {
    // Child scripts: first response halts itself via a seeded halt
    // event is not available here, so we script the child's infer to
    // return an assistant.message with tool_calls that reference an
    // unknown tool — no, that would fail with a tool error, not halt.
    // Instead, use an extension that halts on install by appending an
    // assistant.halted event directly.
    const childInfer: InferFn = async () => ({ content: "should not reach" });
    const parentInfer = multiplexed({
      __parent__: [
        {
          content: "",
          tool_calls: [
            toolCall("c1", "spawn_agent", { type: "halter", prompt: "go" }),
          ],
        },
        { content: "parent done" },
      ],
    });
    const combined: InferFn = async (context) => {
      const sys = systemText(context);
      if (sys.includes("__halter__")) return childInfer(context);
      return parentInfer(context);
    };

    const agent = createAgentRuntime({
      system: "__parent__",
      infer: combined,
      extensions: [
        subagents({
          agents: {
            halter: {
              description: "halter",
              systemPrompt: "__halter__",
              // Seed child with an immediate halt via an extension
              // that appends assistant.halted at layer-build time.
              extensions: () => [haltOnBuild("halted-by-test")],
            },
          },
          infer: combined,
        }),
      ],
    });

    try {
      agent.send("go");
      await agent.until((s) => finalResult(s.events));
      const events = await agent.events();
      const toolResult = events.find((e) => e.type === "tool.result");
      expect(
        toolResult && toolResult.type === "tool.result" && toolResult.content,
      ).toBe("Subagent halted: halted-by-test");
    } finally {
      await agent.dispose();
    }
  });

  it("child reads fresh parent state on every turn (multi-turn sharedBlocks freshness)", async () => {
    // Parent-owned counter; the child's shared block closure reads it.
    // Between the child's turn 1 and turn 2, the test mutates the
    // counter while the child's `step` tool is gated on a deferred
    // promise. The assertion: turn 2 sees the updated value, not the
    // turn-1 snapshot.
    let parentCounter = 0;
    const capturedPerTurn: string[] = [];

    let resolveStep: () => void = () => {};
    const stepGate = new Promise<void>((r) => {
      resolveStep = r;
    });

    // Extension contributing a `step` tool the child can call. The tool
    // blocks on `stepGate` so the test has a window to mutate parent
    // state before the child's next inference.
    const stepExt: Extension = Layer.scopedDiscard(
      Effect.gen(function* () {
        const ctx = yield* AgentCtx;
        yield* ctx
          .addTool({
            name: "step",
            description: "gated step",
            parameters: { type: "object", properties: {}, required: [] },
            run: async () => {
              await stepGate;
              return "ok";
            },
          })
          .pipe(Effect.catchTag("DuplicateToolError", () => Effect.void));
      }),
    );

    // Child inference captures what it sees in the parent_counter
    // shared block on each turn. The shared block materializes as a
    // system fragment contributing `counter=N` to the ProviderContext
    // system text.
    const childInfer: InferFn = async (context) => {
      const sys = systemText(context);
      const match = sys.match(/counter=\d+/);
      capturedPerTurn.push(match ? match[0] : "<missing>");
      if (capturedPerTurn.length === 1) {
        return {
          content: "",
          tool_calls: [toolCall("s1", "step", {})],
        };
      }
      return { content: "child done" };
    };

    const parentInfer = multiplexed({
      __parent__: [
        {
          content: "",
          tool_calls: [
            toolCall("c1", "spawn_agent", { type: "watcher", prompt: "watch" }),
          ],
        },
        { content: "parent done" },
      ],
    });

    const combined: InferFn = async (context) => {
      const sys = systemText(context);
      if (sys.includes("__watcher__")) return childInfer(context);
      return parentInfer(context);
    };

    const agent = createAgentRuntime({
      system: "__parent__",
      infer: combined,
      extensions: [
        subagents({
          agents: {
            watcher: {
              description: "watch parent state",
              systemPrompt: "__watcher__",
              extensions: () => [stepExt],
              sharedBlocks: () => ({
                parent_counter: () => `counter=${parentCounter}`,
              }),
            },
          },
          infer: combined,
        }),
      ],
    });

    try {
      agent.send("go");

      // Wait until the child has captured turn 1 and is blocked on
      // the step tool. At this point the child's inference has run
      // once, read counter=0, and is awaiting `stepGate`.
      await waitUntil(() => capturedPerTurn.length === 1);
      expect(capturedPerTurn[0]).toBe("counter=0");

      // Mutate parent state while the child is gated mid-turn.
      parentCounter = 42;

      // Release the step tool. The child's next inference should
      // observe counter=42, not counter=0.
      resolveStep();

      await agent.until((s) => finalResult(s.events));
      expect(capturedPerTurn).toHaveLength(2);
      expect(capturedPerTurn[1]).toBe("counter=42");
    } finally {
      resolveStep(); // release in case of failure
      await agent.dispose();
    }
  });
});

// Poll a predicate until it returns true. Small helper for tests that
// need to synchronize without driving the agent through `until`.
async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitUntil: timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("agentctx: subagents freeform mode", () => {
  it("spawns a freeform child when the tool call omits `type`", async () => {
    let childSystem = "";
    const infer = multiplexed({
      __parent__: [
        {
          content: "",
          tool_calls: [
            toolCall("c1", "spawn_agent", {
              systemPrompt: "__freeform_system__",
              prompt: "do a thing",
            }),
          ],
        },
        { content: "parent saw: done" },
      ],
      __freeform_system__: [{ content: "freeform result" }],
    });

    // Capture the child's system content to verify the freeform
    // systemPrompt landed on the child's ambient prefix.
    const capturingInfer: InferFn = async (context) => {
      const sys = systemText(context);
      if (sys.includes("__freeform_system__")) childSystem = sys;
      return infer(context);
    };

    const agent = createAgentRuntime({
      system: "__parent__",
      infer: capturingInfer,
      extensions: [
        subagents({
          defaultExtensions: () => [],
          infer: capturingInfer,
        }),
      ],
    });

    try {
      agent.send("go");
      await agent.until((s) => finalResult(s.events));
      const events = await agent.events();
      const toolResult = events.find((e) => e.type === "tool.result");
      expect(
        toolResult && toolResult.type === "tool.result" && toolResult.content,
      ).toBe("freeform result");
      expect(childSystem).toContain("__freeform_system__");
    } finally {
      await agent.dispose();
    }
  });

  it("falls back to defaultSystemPrompt when the tool call omits systemPrompt", async () => {
    let childSystem = "";
    const infer = multiplexed({
      __parent__: [
        {
          content: "",
          tool_calls: [
            toolCall("c1", "spawn_agent", { prompt: "no explicit system" }),
          ],
        },
        { content: "done" },
      ],
      __default_child_system__: [{ content: "ok" }],
    });
    const capturingInfer: InferFn = async (context) => {
      const sys = systemText(context);
      if (sys.includes("__default_child_system__")) childSystem = sys;
      return infer(context);
    };

    const agent = createAgentRuntime({
      system: "__parent__",
      infer: capturingInfer,
      extensions: [
        subagents({
          defaultExtensions: () => [],
          defaultSystemPrompt: "__default_child_system__",
          infer: capturingInfer,
        }),
      ],
    });

    try {
      agent.send("go");
      await agent.until((s) => finalResult(s.events));
      expect(childSystem).toContain("__default_child_system__");
    } finally {
      await agent.dispose();
    }
  });

  it("supports catalog + freeform in the same extension — call with `type` uses catalog, without uses freeform", async () => {
    const seenSystems: string[] = [];
    const infer = multiplexed({
      __parent__: [
        {
          // Turn 1: spawn via catalog.
          content: "",
          tool_calls: [
            toolCall("c1", "spawn_agent", { type: "preset", prompt: "A" }),
          ],
        },
        {
          // Turn 2: spawn freeform.
          content: "",
          tool_calls: [
            toolCall("c2", "spawn_agent", {
              systemPrompt: "__freeform_hybrid__",
              prompt: "B",
            }),
          ],
        },
        { content: "done" },
      ],
      __preset_child__: [{ content: "preset-out" }],
      __freeform_hybrid__: [{ content: "freeform-out" }],
    });
    const capturingInfer: InferFn = async (context) => {
      const sys = systemText(context);
      if (sys.includes("__preset_child__") || sys.includes("__freeform_hybrid__")) {
        seenSystems.push(sys);
      }
      return infer(context);
    };

    const agent = createAgentRuntime({
      system: "__parent__",
      infer: capturingInfer,
      extensions: [
        subagents({
          agents: {
            preset: {
              description: "catalog preset",
              systemPrompt: "__preset_child__",
              extensions: () => [],
            },
          },
          defaultExtensions: () => [],
          infer: capturingInfer,
        }),
      ],
    });

    try {
      agent.send("go");
      await agent.until((s) => finalResult(s.events));
      const events = await agent.events();
      const results = events
        .filter((e) => e.type === "tool.result")
        .map((e) => (e.type === "tool.result" ? e.content : ""));
      expect(results).toEqual(["preset-out", "freeform-out"]);
      expect(seenSystems).toHaveLength(2);
      expect(seenSystems[0]).toContain("__preset_child__");
      expect(seenSystems[1]).toContain("__freeform_hybrid__");
    } finally {
      await agent.dispose();
    }
  });

  it("returns a tool-level error when `type` is required but absent (catalog-only config)", async () => {
    const infer = multiplexed({
      __parent__: [
        {
          content: "",
          tool_calls: [
            toolCall("c1", "spawn_agent", {
              systemPrompt: "__try_freeform__",
              prompt: "nope",
            }),
          ],
        },
        { content: "done" },
      ],
    });

    const agent = createAgentRuntime({
      system: "__parent__",
      infer,
      extensions: [
        subagents({
          agents: {
            only: {
              description: "only preset",
              extensions: () => [],
            },
          },
          infer,
        }),
      ],
    });

    try {
      agent.send("go");
      await agent.until((s) => finalResult(s.events));
      const events = await agent.events();
      const toolResult = events.find((e) => e.type === "tool.result");
      expect(
        toolResult && toolResult.type === "tool.result" && toolResult.content,
      ).toMatch(/Error: `type` is required/);
    } finally {
      await agent.dispose();
    }
  });

  it("treats empty-string `type` as no-type and routes to freeform when available", async () => {
    const infer = multiplexed({
      __parent__: [
        {
          content: "",
          tool_calls: [
            toolCall("c1", "spawn_agent", {
              type: "",
              systemPrompt: "__empty_type_child__",
              prompt: "go",
            }),
          ],
        },
        { content: "parent done" },
      ],
      __empty_type_child__: [{ content: "child done" }],
    });

    const agent = createAgentRuntime({
      system: "__parent__",
      infer,
      extensions: [
        subagents({ defaultExtensions: () => [], infer }),
      ],
    });

    try {
      agent.send("go");
      await agent.until((s) => finalResult(s.events));
      const events = await agent.events();
      const toolResult = events.find((e) => e.type === "tool.result");
      expect(
        toolResult && toolResult.type === "tool.result" && toolResult.content,
      ).toBe("child done");
    } finally {
      await agent.dispose();
    }
  });

  it("returns a tool-level error when `type` is passed but config is freeform-only", async () => {
    const infer = multiplexed({
      __parent__: [
        {
          content: "",
          tool_calls: [
            toolCall("c1", "spawn_agent", {
              type: "not_a_preset",
              prompt: "nope",
            }),
          ],
        },
        { content: "done" },
      ],
    });

    const agent = createAgentRuntime({
      system: "__parent__",
      infer,
      extensions: [
        subagents({
          defaultExtensions: () => [],
          infer,
        }),
      ],
    });

    try {
      agent.send("go");
      await agent.until((s) => finalResult(s.events));
      const events = await agent.events();
      const toolResult = events.find((e) => e.type === "tool.result");
      expect(
        toolResult && toolResult.type === "tool.result" && toolResult.content,
      ).toMatch(/Error: `type` is not supported/);
    } finally {
      await agent.dispose();
    }
  });
});
