import { Effect, Layer, Schema } from "effect";
import { AgentCtx, defineTool, type Extension } from "@flamecast/agentjsx";
import type { UserModelStore } from "../user-model-store";

// Hermes uses Honcho for dialectic user modeling — a separate service
// that maintains a structured model of who the user is across
// sessions. The model only matters if the agent SEES it each turn AND
// can refine it as it learns more.
//
// Two contributions:
//   - An Effect-valued ambient that injects the current model as a
//     "Who you're talking to" fragment, recomputed each render.
//   - `update_user_model` / `forget_user_model` tools that let the
//     agent write back what it learns. (Real Honcho derives the model
//     automatically from conversation; this version is agent-driven.)

export interface UserModelOptions {
  readonly store: UserModelStore;
  readonly heading?: string;
  readonly upsertToolName?: string;
  readonly removeToolName?: string;
  // When true, only the ambient is registered — no write tools. Used
  // for subagents that should see the user model but not mutate it
  // (matches Hermes's blocklist: children never hold `memory`).
  readonly readonly?: boolean;
}

export const userModel = (opts: UserModelOptions): Extension => {
  const heading = opts.heading ?? "## Who you're talking to";
  const upsertName = opts.upsertToolName ?? "update_user_model";
  const removeName = opts.removeToolName ?? "forget_user_model";
  const readOnly = opts.readonly ?? false;

  return Layer.scopedDiscard(
    Effect.gen(function* () {
      const ctx = yield* AgentCtx;

      yield* ctx.addAmbient({
        name: "hermes/user-model",
        content: Effect.promise(async () => {
          try {
            const entries = await opts.store.read();
            if (entries.length === 0) return "";
            const body = entries
              .map((e) => `- **${e.key}**: ${e.value}`)
              .join("\n");
            return `${heading}\n\n${body}`;
          } catch {
            return "";
          }
        }),
      });

      if (readOnly) return;

      yield* ctx.addTool(
        defineTool({
          name: upsertName,
          description:
            "Record or update one fact about the user — a preference, a working " +
            "style, a piece of context that will be useful next session. Use a " +
            "short, stable key (e.g. 'editor', 'tone', 'timezone').",
          parameters: Schema.Struct({
            key: Schema.String,
            value: Schema.String,
          }),
          run: async ({ key, value }) => {
            await opts.store.upsert({ key, value });
            return `Updated user model: ${key} = ${value}.`;
          },
        }),
      ).pipe(
        Effect.catchTag("DuplicateToolError", (err) =>
          ctx.reportError("hermes/user-model:upsert", err),
        ),
      );

      yield* ctx.addTool(
        defineTool({
          name: removeName,
          description:
            "Remove an entry from the user model when it's no longer accurate.",
          parameters: Schema.Struct({
            key: Schema.String,
          }),
          run: async ({ key }) => {
            const removed = await opts.store.remove(key);
            return removed
              ? `Removed user-model entry: ${key}.`
              : `No user-model entry with key "${key}".`;
          },
        }),
      ).pipe(
        Effect.catchTag("DuplicateToolError", (err) =>
          ctx.reportError("hermes/user-model:remove", err),
        ),
      );
    }),
  );
};
