import { Effect, Layer, Schema } from "effect";
import { AgentCtx } from "../core/agent-ctx";
import type { Extension } from "../core/agent";
import { registerTool } from "./tool-registration";

// One discoverable skill — a directory on disk with a SKILL.md whose
// YAML frontmatter has a `name` and `description`. Body (and any
// supporting files) are lazy — the LLM loads them on demand via
// `load_skill`, keeping the ambient tool surface cheap.
export interface SkillEntry {
  name: string;
  description: string;
  // Arbitrary handle the backend uses to fetch the full body.
  handle: string;
}

export interface SkillBackend {
  // Return the full SKILL.md body. Backend-agnostic — CLI backend reads
  // from disk, other hosts can back skills with a DB, a remote service,
  // etc.
  read(handle: string): Promise<string | null>;
}

export interface SkillsOptions {
  skills: SkillEntry[];
  backend: SkillBackend;
  toolName?: string; // Default "load_skill".
}

// Registers a `load_skill` tool + an ambient system block listing every
// available skill as `<name>: <description>`. Follows Claude Code's
// pattern: the LLM sees the short index every turn, calls `load_skill`
// to read the full playbook on demand.
export const skills = (opts: SkillsOptions): Extension => {
  const { skills: catalog, backend, toolName = "load_skill" } = opts;

  return Layer.scopedDiscard(
    Effect.gen(function* () {
      const ctx = yield* AgentCtx;

      if (catalog.length > 0) {
        const menu = catalog
          .map((s) => `- **${s.name}**: ${s.description}`)
          .join("\n");
        yield* ctx.addAmbient({
          name: "skills",
          content: `## Available skills\n\n${menu}\n\nCall \`${toolName}(name)\` to read the full instructions for one.`,
        });
      }

      yield* registerTool(ctx, "skills", {
        name: toolName,
        description: `Load the full instructions for a skill by name. Returns the SKILL.md body. Available skills: ${
          catalog.map((s) => s.name).join(", ") || "(none configured)"
        }.`,
        parameters: Schema.Struct({
          name: Schema.String.annotations({
            description: "Skill name, matching the `name:` in its frontmatter.",
          }),
        }),
        run: async (args) => {
          const name = args.name.trim();
          const entry = catalog.find((s) => s.name === name);
          if (!entry) {
            return `Unknown skill: "${name}". Available: ${catalog.map((s) => s.name).join(", ")}.`;
          }
          const body = await backend.read(entry.handle);
          if (body == null) return `Error: skill "${name}" has no readable body.`;
          return body;
        },
      });
    }),
  );
};
