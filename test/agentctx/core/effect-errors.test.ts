import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentCtx,
  createAgentRuntime,
  InferenceError,
  ToolExecutionError,
} from "@flamecast/agentjsx";
import type { Extension, InferFn, InferResponse } from "@flamecast/agentjsx";
import { scriptedInfer, toolCall } from "../helpers/scripted-infer";

describe("agentctx: error surfacing and fiber recovery", () => {
  it("surfaces async inference rejection on agent.errors without killing the fiber", async () => {
    // The signals variant tested `createEffect` rejections — in the
    // agentctx runtime the analogue is the inference fiber. An infer()
    // that throws must land as an AgentErrorEntry with phase "inference"
    // and must not tear down the loop.
    const boom = new Error("boom-async");
    let calls = 0;
    const infer: InferFn = async (): Promise<InferResponse> => {
      calls++;
      if (calls === 1) throw boom;
      return { content: "recovered" };
    };

    const agent = createAgentRuntime({ infer });
    try {
      agent.run("hi");

      const errs = await agent.until((s) =>
        s.errors.length > 0 ? s.errors : null,
      );
      expect(errs).toHaveLength(1);
      const entry = errs[0];
      expect(entry.phase).toBe("inference");
      // Error is wrapped in an InferenceError tag.
      expect(entry.error).toBeInstanceOf(InferenceError);
      if (entry.error instanceof InferenceError) {
        expect(entry.error.cause).toBe(boom);
      }

      // Fiber recovery: a second user message must still produce a
      // response — the inference loop caught the error rather than dying.
      agent.run("again");
      const result = await agent.until((s) => {
        const last = s.events.at(-1);
        return last?.type === "assistant.message" && last.content === "recovered"
          ? last
          : null;
      });
      expect(result.content).toBe("recovered");

      // The original error remains visible on agent.errors.
      const finalErrs = await agent.errors();
      expect(finalErrs.some((e) => e.error instanceof InferenceError)).toBe(true);
    } finally {
      await agent.dispose();
    }
  });

  it("a throwing tool surfaces on ctx.errors AND as a string tool.result the LLM can read", async () => {
    // Dev-visibility path: tool-run throws go through the single
    // dispatcher catch site — which returns `Error: <msg>` content
    // for the LLM *and* reports the full ToolExecutionError (with
    // stack-bearing cause) to ctx.errors so operators see bugs.
    const bug = new Error("cannot read properties of undefined");
    const buggyTool: Extension = Layer.scopedDiscard(
      Effect.gen(function* () {
        const ctx = yield* AgentCtx;
        yield* ctx
          .addTool({
            name: "buggy",
            description: "throws",
            parameters: { type: "object", properties: {}, required: [] },
            run: async () => {
              throw bug;
            },
          })
          .pipe(Effect.catchTag("DuplicateToolError", () => Effect.void));
      }),
    );

    const infer = scriptedInfer([
      { content: "", tool_calls: [toolCall("c1", "buggy")] },
      { content: "done" },
    ]);

    const agent = createAgentRuntime({ infer, extensions: [buggyTool] });
    try {
      agent.run("go");
      await agent.until((s) => {
        const last = s.events.at(-1);
        return last?.type === "assistant.message" && last.content === "done"
          ? last
          : null;
      });

      // LLM-facing: tool.result contains the error string.
      const events = await agent.events();
      const toolResult = events.find((e) => e.type === "tool.result");
      expect(
        toolResult && toolResult.type === "tool.result" && toolResult.content,
      ).toBe("Error: cannot read properties of undefined");

      // Dev-facing: ctx.errors carries the full ToolExecutionError with
      // original cause intact.
      const errs = await agent.errors();
      const toolErrs = errs.filter((e) => e.phase === "tool:buggy");
      expect(toolErrs).toHaveLength(1);
      expect(toolErrs[0].error).toBeInstanceOf(ToolExecutionError);
      if (toolErrs[0].error instanceof ToolExecutionError) {
        expect(toolErrs[0].error.cause).toBe(bug);
      }
    } finally {
      await agent.dispose();
    }
  });

  it("surfaces a second inference failure without swallowing the first", async () => {
    const infer = scriptedInfer([
      { content: "unused", reject: new Error("first") },
      { content: "unused", reject: new Error("second") },
      { content: "finally" },
    ]);

    const agent = createAgentRuntime({ infer });
    try {
      agent.run("one");
      await agent.until((s) => (s.errors.length >= 1 ? s.errors : null));

      agent.run("two");
      const errs = await agent.until((s) =>
        s.errors.length >= 2 ? s.errors : null,
      );
      expect(errs.length).toBeGreaterThanOrEqual(2);

      agent.run("three");
      const last = await agent.until((s) => {
        const tail = s.events.at(-1);
        return tail?.type === "assistant.message" && tail.content === "finally"
          ? tail
          : null;
      });
      expect(last.content).toBe("finally");
    } finally {
      await agent.dispose();
    }
  });
});
