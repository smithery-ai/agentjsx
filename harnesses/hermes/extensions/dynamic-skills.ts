import { Effect, Layer, Schema } from "effect";
import { AgentCtx, defineTool, type Extension } from "@flamecast/agentjsx";
import type { SkillStore } from "../skill-store";

// Read-side counterpart to `learning-loop`. Where the core `skills`
// extension takes a static catalog at startup, this one re-reads the
// catalog from a `SkillStore` on every render — so a skill the model
// saves via `save_skill` shows up in the menu on the very next turn.
//
// Two contributions:
//   - An Effect-valued ambient that lists every skill currently on disk.
//   - A `load_skill` tool that fetches a body by name (falls back to
//     handle if no name match — useful for update_skill round-trips).

export interface DynamicSkillsOptions {
  readonly store: SkillStore;
  readonly toolName?: string;
  readonly heading?: string;
}

export const dynamicSkills = (opts: DynamicSkillsOptions): Extension => {
  const toolName = opts.toolName ?? "load_skill";
  const heading = opts.heading ?? "## Available skills";

  return Layer.scopedDiscard(
    Effect.gen(function* () {
      const ctx = yield* AgentCtx;

      yield* ctx.addAmbient({
        name: "hermes/skills-catalog",
        content: Effect.promise(async () => {
          try {
            const catalog = await opts.store.list();
            if (catalog.length === 0) {
              return `${heading}\n\n(none yet - call \`save_skill\` when you discover something worth keeping.)`;
            }
            const menu = catalog
              .map((s) => {
                const flags: string[] = [];
                if (s.usage.pinned) flags.push("pinned");
                if (s.usage.state === "stale") flags.push("stale");
                const tag = flags.length ? ` _[${flags.join(", ")}]_` : "";
                return `- **${s.name}** \`(${s.handle})\`${tag} - ${s.description}`;
              })
              .join("\n");
            return `${heading}\n\n${menu}\n\nCall \`${toolName}({ name })\` to read the full instructions.`;
          } catch {
            return "";
          }
        }),
      });

      yield* ctx.addTool(
        defineTool({
          name: toolName,
          description:
            "Load the full SKILL.md body for one of the skills listed in the system prompt. " +
            "Pass either the skill's name or its handle.",
          parameters: Schema.Struct({
            name: Schema.String,
          }),
          run: async ({ name }) => {
            const target = name.trim();
            const catalog = await opts.store.list();
            const entry =
              catalog.find((s) => s.name === target) ??
              catalog.find((s) => s.handle === target);
            if (!entry) {
              const available =
                catalog.map((s) => s.name).join(", ") || "(none)";
              return `Unknown skill: "${target}". Available: ${available}.`;
            }
            const body = await opts.store.read(entry.handle);
            if (body == null) {
              return `Error: skill "${entry.name}" has no readable body.`;
            }
            await opts.store.bumpView(entry.handle);
            await opts.store.bumpUse(entry.handle);
            return body;
          },
        }),
      ).pipe(
        Effect.catchTag("DuplicateToolError", (err) =>
          ctx.reportError("hermes/dynamic-skills", err),
        ),
      );
    }),
  );
};
