import { Effect, Layer, Schema } from "effect";
import { AgentCtx, defineTool, type Extension } from "@flamecast/agentjsx";
import type { SkillStore } from "../skill-store";

// Write-side of Hermes's skill loop. Read-side is `dynamicSkills`.
//
// Hermes creates skills autonomously after a task completes: the model
// reflects on what it just did and drafts a SKILL.md. The draft is
// persisted to the same store the read-side ambient enumerates from,
// so the new skill shows up in the catalog on the very next turn.
//
// Self-improvement (rewriting an existing skill mid-use) is the same
// flow targeting a known handle.

export interface LearningLoopOptions {
  readonly store: SkillStore;
  readonly saveToolName?: string;
  readonly updateToolName?: string;
}

export const learningLoop = (opts: LearningLoopOptions): Extension => {
  const saveName = opts.saveToolName ?? "save_skill";
  const updateName = opts.updateToolName ?? "update_skill";

  return Layer.scopedDiscard(
    Effect.gen(function* () {
      const ctx = yield* AgentCtx;

      yield* ctx.addTool(
        defineTool({
          name: saveName,
          description:
            "Persist a new SKILL.md from the work you just did. Use when you've " +
            "discovered a workflow, command, or pattern worth keeping for future " +
            "sessions. The skill becomes available next turn under its name.",
          parameters: Schema.Struct({
            name: Schema.String,
            description: Schema.String,
            body: Schema.String,
          }),
          run: async (draft) => {
            const entry = await opts.store.save(draft);
            return `Saved skill "${entry.name}" (handle: ${entry.handle}). It will appear in the skills catalog next turn.`;
          },
        }),
      ).pipe(
        Effect.catchTag("DuplicateToolError", (err) =>
          ctx.reportError("hermes/learning-loop:save", err),
        ),
      );

      yield* ctx.addTool(
        defineTool({
          name: updateName,
          description:
            "Rewrite an existing skill. Use when a skill you just loaded had a gap, " +
            "missed an edge case, or has a better approach you discovered while using it. " +
            "Pass the handle from the catalog.",
          parameters: Schema.Struct({
            handle: Schema.String,
            name: Schema.String,
            description: Schema.String,
            body: Schema.String,
          }),
          run: async ({ handle, ...draft }) => {
            const entry = await opts.store.update(handle, draft);
            await opts.store.bumpPatch(entry.handle);
            return `Updated skill "${entry.name}" (handle: ${entry.handle}).`;
          },
        }),
      ).pipe(
        Effect.catchTag("DuplicateToolError", (err) =>
          ctx.reportError("hermes/learning-loop:update", err),
        ),
      );
    }),
  );
};
