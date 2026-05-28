import { Effect, Layer, Schema } from "effect";
import { AgentCtx, defineTool, type Extension } from "@flamecast/agentjsx";

// Mirrors Hermes's `clarify_tool.py`. The model can interrupt its own
// reasoning to ask the user a question — open-ended or with up to 4
// predefined choices.
//
// Hermes injects the actual UI logic via a platform-provided callback
// (CLI uses arrow-key navigation, messaging platforms render numbered
// lists). We mirror that boundary: the host passes an `ask` function;
// the extension shapes the tool surface and validates inputs.
//
// This is the right place for the host/agent boundary — Hermes treats
// children's lack of `clarify` as a load-bearing isolation property
// (see DELEGATE_BLOCKED_TOOLS in delegate_tool.py), so the extension
// stays optional and per-loadout.

export const MAX_CHOICES = 4;

export interface ClarifyAsk {
  readonly question: string;
  readonly choices?: readonly string[];
}

export interface ClarifyHost {
  readonly ask: (req: ClarifyAsk) => Promise<string>;
}

export interface ClarifyOptions {
  readonly host: ClarifyHost;
  readonly toolName?: string;
}

export const clarify = (opts: ClarifyOptions): Extension => {
  const toolName = opts.toolName ?? "clarify";

  return Layer.scopedDiscard(
    Effect.gen(function* () {
      const ctx = yield* AgentCtx;

      yield* ctx.addTool(
        defineTool({
          name: toolName,
          description:
            "Ask the user a clarifying question. Use sparingly — only when you " +
            "genuinely need user input to proceed and reasonable assumptions " +
            "would risk wrong work. Provide up to 4 short answer choices when " +
            "the question has discrete options; omit `choices` for open-ended " +
            "questions.",
          parameters: Schema.Struct({
            question: Schema.String,
            choices: Schema.optional(Schema.Array(Schema.String)),
          }),
          run: async ({ question, choices }) => {
            if (choices && choices.length > MAX_CHOICES) {
              return `Error: at most ${MAX_CHOICES} choices allowed (got ${choices.length}).`;
            }
            const answer = await opts.host.ask({
              question,
              choices: choices ? [...choices] : undefined,
            });
            return JSON.stringify({ answer });
          },
        }),
      ).pipe(
        Effect.catchTag("DuplicateToolError", (err) =>
          ctx.reportError("hermes/clarify", err),
        ),
      );
    }),
  );
};
