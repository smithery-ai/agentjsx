import { Data } from "effect";

// Tagged errors for the agent runtime. Each failure mode gets its own tag so
// callers can discriminate via `Effect.catchTag` / `Effect.catchTags` without
// losing type-level tracking of the remaining error union.

export class InferenceError extends Data.TaggedError("InferenceError")<{
  readonly cause: unknown;
}> {
  // Surface the underlying cause's message through `.message` so
  // consumers (e.g. defaultAgentTerminal) that format with
  // `err.message` don't render as "inference: " with an empty tail.
  get message(): string {
    return this.cause instanceof Error
      ? this.cause.message
      : String(this.cause);
  }
}

export class ToolExecutionError extends Data.TaggedError("ToolExecutionError")<{
  readonly toolName: string;
  readonly toolCallId: string;
  readonly cause: unknown;
}> {
  get message(): string {
    return this.cause instanceof Error
      ? this.cause.message
      : String(this.cause);
  }
}

export class DuplicateToolError extends Data.TaggedError("DuplicateToolError")<{
  readonly toolName: string;
}> {}

export type AgentError = InferenceError | ToolExecutionError | DuplicateToolError;
