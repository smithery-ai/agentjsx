import type { InferFn, InferResponse, ToolCall } from "@flamecast/agentjsx";

export interface ScriptedStep {
  readonly content: string;
  readonly tool_calls?: ReadonlyArray<ToolCall>;
  readonly delay?: number;
  readonly reject?: Error;
}

// Programmable InferFn. Consumes `steps` in order; the nth call returns the
// nth step. Used by the core-invariant tests to drive deterministic
// assistant responses without reaching for a live LLM.
export const scriptedInfer = (steps: ReadonlyArray<ScriptedStep>): InferFn => {
  let i = 0;
  return async (): Promise<InferResponse> => {
    const step = steps[i++];
    if (!step) throw new Error(`scriptedInfer exhausted after ${i - 1} calls`);
    if (step.delay !== undefined) {
      await new Promise<void>((r) => setTimeout(r, step.delay));
    }
    if (step.reject) throw step.reject;
    return {
      content: step.content,
      tool_calls: step.tool_calls ? [...step.tool_calls] : undefined,
    };
  };
};

export const toolCall = (
  id: string,
  name: string,
  args: Record<string, unknown> = {},
): ToolCall => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
