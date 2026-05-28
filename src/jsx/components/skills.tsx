// Capability component — exposes a directory of skill folders to the
// agent. Each `<root>/<name>/SKILL.md` is a discoverable "skill"; the
// component emits an ambient block listing each skill's short
// description and declares two tools (`skill_lookup`, `skill_invoke`)
// the model can call to pull a skill's body into its working context.
// References live as sibling files in the skill's folder (e.g.
// `<root>/<name>/references/foo.md`) and can be loaded via the
// Workspace's `read_file` tool when the skill points at them.
//
// Semantic note on the two tools: implementations are identical for
// MVP — both read the skill body and return it. The split exists to
// give the model two intentions:
//   - `skill_lookup`: discovery (peek at a skill body without
//     committing to use it).
//   - `skill_invoke`: actually pulling the skill into the working
//     context to follow it.
// Same bytes returned either way; the distinction is purely for the
// model's planning vocabulary.
//
// Synchronous-render constraint: the JSX walk is synchronous but
// reading the skills directory is async via `runEffect`. We use
// strategy (b) — a module-level cache keyed by `root`. First render
// for a given root emits `<skills>(loading...)</skills>` and kicks off
// a fire-and-forget fetch that populates the cache. The next render
// (triggered by the next agent event — user message, tool result,
// etc.) sees the populated cache and emits the real listing. There is
// no `ctx.invalidate` plumbed through RenderContext today, so the
// loading state lingers until the next natural render. Acceptable
// MVP UX: first turn shows "(loading...)", subsequent turns show the
// real listing.

import { FileSystem, Path } from "@effect/platform";
import { Effect, Schema } from "effect";
import { defineTool } from "../../core/define-tool";
import type { Fragment as RenderedFragment } from "../../core/types";
import {
  emitCommand,
  emitFragment,
  emitTool,
  type Element,
  type Node,
} from "../runtime";
import { useRenderContext } from "../render";

interface SkillCommand {
  name: string;
  prompt: string;
}

interface SkillEntry {
  name: string;
  description: string;
  commands: SkillCommand[];
}

interface CacheState {
  loading: boolean;
  entries: SkillEntry[];
  // The directory-missing case is a valid state, not an error — the
  // listing renders as empty. Stored so the `(loading...)` placeholder
  // doesn't stick around for a directory that will never produce entries.
  resolved: boolean;
}

// Module-level cache. Keyed by absolute-ish root string as passed in
// by the caller. Survives the lifetime of the JS module, which is the
// agent's process — acceptable for MVP. A long-running agent that
// expects skills to be edited on disk and re-listed would need an
// invalidation hook; punted.
const cache = new Map<string, CacheState>();

// Derive a one-line description from a markdown file's body. Strategy:
// scan lines, skip blank lines and lines that look like markdown
// headings (`#`, `##`, etc.) or horizontal rules. Return the first
// remaining non-empty line, trimmed. Used as the fallback when no
// YAML frontmatter is present. If nothing usable is found, returns
// "(no description)".
function deriveDescription(body: string): string {
  const lines = body.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;
    if (/^-{3,}$/.test(line)) continue;
    return line;
  }
  return "(no description)";
}

// Parse the YAML frontmatter fields from a raw frontmatter block.
// Tiny inline parser: one `key: value` per line. Quoted values have
// their surrounding quotes stripped. No nested structures, no lists.
// That's all the skill spec needs for `name` and `description`.
function parseFrontmatterFields(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([a-zA-Z_][\w-]*):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    let value = m[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[m[1]!] = value;
  }
  return out;
}

// Parse the `commands:` list out of a frontmatter block. Shape:
//   commands:
//     - name: review
//       prompt: "Review the current diff."
//     - name: ship
//       prompt: "Land the current work as a PR."
// Tiny indentation-aware parser; values may be quoted. Malformed
// entries (missing `name` or `prompt`) are skipped with a warning.
// Returns [] if the field is absent. Throws are caught at the call
// site so a bad `commands:` block doesn't crash the component.
function parseFrontmatterCommands(raw: string): SkillCommand[] {
  const lines = raw.split(/\r?\n/);
  let i = 0;
  // Find the `commands:` line.
  while (i < lines.length && !/^commands\s*:\s*$/.test(lines[i]!.trim())) i++;
  if (i >= lines.length) return [];
  i++;
  const out: SkillCommand[] = [];
  let current: Partial<SkillCommand> | null = null;
  const stripQuotes = (v: string) => {
    const t = v.trim();
    if (
      (t.startsWith('"') && t.endsWith('"')) ||
      (t.startsWith("'") && t.endsWith("'"))
    ) {
      return t.slice(1, -1);
    }
    return t;
  };
  const flush = () => {
    if (!current) return;
    if (
      typeof current.name === "string" &&
      current.name.length > 0 &&
      typeof current.prompt === "string" &&
      current.prompt.length > 0
    ) {
      out.push({ name: current.name, prompt: current.prompt });
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        `[skills] skipping malformed command entry: ${JSON.stringify(current)}`,
      );
    }
    current = null;
  };
  for (; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    // A non-indented line ends the commands block.
    if (!/^\s/.test(raw)) break;
    const itemMatch = /^\s*-\s*(.*)$/.exec(raw);
    if (itemMatch) {
      flush();
      current = {};
      const rest = itemMatch[1]!.trim();
      if (rest.length > 0) {
        const kv = /^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/.exec(rest);
        if (kv) {
          const k = kv[1]!;
          const v = stripQuotes(kv[2]!);
          if (k === "name") current.name = v;
          else if (k === "prompt") current.prompt = v;
        }
      }
      continue;
    }
    if (!current) continue;
    const kv = /^\s+([a-zA-Z_][\w-]*)\s*:\s*(.*)$/.exec(raw);
    if (!kv) continue;
    const k = kv[1]!;
    const v = stripQuotes(kv[2]!);
    if (k === "name") current.name = v;
    else if (k === "prompt") current.prompt = v;
  }
  flush();
  return out;
}

// Parse a skill file into its description (one-liner shown in the
// `<skills>` menu), body (full markdown the model sees on
// `skill_lookup`/`skill_invoke`), and any declared slash commands.
// If the file starts with a YAML frontmatter block (`---\n...\n---\n`),
// the `description` field supplies the menu line and `commands:` (if
// present) defines slash commands the skill registers. The body is
// everything after the closing fence. If no frontmatter is present,
// falls back to the heuristic: description is the first non-heading,
// non-blank line; body is the full file; no commands.
export function parseSkillFile(content: string): {
  description: string;
  body: string;
  commands: SkillCommand[];
} {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!m) {
    return {
      description: deriveDescription(content),
      body: content,
      commands: [],
    };
  }
  const frontmatterRaw = m[1]!;
  const body = m[2] ?? "";
  const fields = parseFrontmatterFields(frontmatterRaw);
  const description =
    fields.description && fields.description.length > 0
      ? fields.description
      : deriveDescription(body);
  let commands: SkillCommand[] = [];
  try {
    commands = parseFrontmatterCommands(frontmatterRaw);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      `[skills] failed to parse commands frontmatter: ${e instanceof Error ? e.message : String(e)}`,
    );
    commands = [];
  }
  return { description, body, commands };
}

function listSkills(
  root: string,
): Effect.Effect<SkillEntry[], never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const p = yield* Path.Path;
    const exists = yield* fs.exists(root);
    if (!exists) return [] as SkillEntry[];
    const entries = yield* fs.readDirectory(root);
    const out: SkillEntry[] = [];
    for (const entry of entries) {
      const dir = p.resolve(root, entry);
      const stat = yield* fs.stat(dir).pipe(Effect.catchAll(() => Effect.succeed(null)));
      if (!stat || stat.type !== "Directory") continue;
      const skillFile = p.resolve(dir, "SKILL.md");
      const skillExists = yield* fs.exists(skillFile);
      if (!skillExists) continue;
      const content = yield* fs
        .readFileString(skillFile)
        .pipe(Effect.catchAll(() => Effect.succeed("")));
      const { description, commands } = parseSkillFile(content);
      out.push({ name: entry, description, commands });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }).pipe(
    Effect.catchAll(() => Effect.succeed([] as SkillEntry[])),
  ) as Effect.Effect<SkillEntry[], never, FileSystem.FileSystem | Path.Path>;
}

export interface SkillsProps {
  readonly root: string;
}

export function Skills(props: SkillsProps): Node {
  const { root } = props;
  const { runEffect } = useRenderContext();

  // Cache check + fire-and-forget population. See the file-level comment
  // for why this is the chosen strategy.
  let state = cache.get(root);
  if (!state) {
    state = { loading: true, entries: [], resolved: false };
    cache.set(root, state);
    // Fire-and-forget. The render walk doesn't await this; the next
    // natural render after this resolves will see `resolved: true`.
    void runEffect(
      listSkills(root) as unknown as Effect.Effect<SkillEntry[], never, never>,
    )
      .then((entries) => {
        cache.set(root, { loading: false, entries, resolved: true });
      })
      .catch(() => {
        // listSkills swallows errors, but be defensive against runEffect
        // itself rejecting (e.g. no platform layer wired). An empty
        // resolved state is the right MVP fallback — the model sees an
        // empty `<skills>` block and the tools still report errors if
        // called.
        cache.set(root, { loading: false, entries: [], resolved: true });
      });
  }

  // Skill body reader, shared by both tools. Resolves
  // `<root>/<name>/SKILL.md` and returns its contents, or a "not found"
  // string. Errors are converted to a clear `[skill_*] Error: ...` prefix.
  const readSkill = (name: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const p = yield* Path.Path;
      const target = p.resolve(root, name, "SKILL.md");
      const exists = yield* fs.exists(target);
      if (!exists) return `Skill not found: ${name}`;
      const content = yield* fs.readFileString(target);
      // Strip frontmatter from the returned body so the LLM doesn't
      // see YAML cruft. Plain-markdown files (no frontmatter) pass
      // through unchanged via the fallback in parseSkillFile.
      const { body } = parseSkillFile(content);
      return body;
    }).pipe(
      Effect.catchAll((e) =>
        Effect.succeed(
          `Error: ${e instanceof Error ? e.message : String(e)}`,
        ),
      ),
    ) as unknown as Effect.Effect<string, never, never>;

  const skill_lookup = defineTool({
    name: "skill_lookup",
    description:
      "Look up a skill by name to preview its instructions. Returns the skill's markdown body, or a not-found message. Use this to decide whether a skill is relevant before committing to follow it.",
    parameters: Schema.Struct({
      name: Schema.String,
    }),
    run: async ({ name }) => {
      try {
        return await runEffect(readSkill(name));
      } catch (e) {
        return `[skill_lookup] Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  // Same implementation as skill_lookup for MVP — see file-level
  // comment for the intent split. `invoke` signals to the model "I'm
  // pulling this into my working context to follow it now."
  const skill_invoke = defineTool({
    name: "skill_invoke",
    description:
      "Invoke a skill by name to pull its full instructions into your working context. Returns the skill's markdown body. Use this once you've decided to follow a skill's playbook.",
    parameters: Schema.Struct({
      name: Schema.String,
    }),
    run: async ({ name }) => {
      try {
        return await runEffect(readSkill(name));
      } catch (e) {
        return `[skill_invoke] Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  let content: string;
  if (!state.resolved) {
    content = `<skills>\n(loading...)\n</skills>`;
  } else if (state.entries.length === 0) {
    content = `<skills>\n(none)\n</skills>`;
  } else {
    const lines: string[] = [];
    for (const s of state.entries) {
      lines.push(`- ${s.name}: ${s.description}`);
      for (const c of s.commands) {
        lines.push(`    /${c.name}`);
      }
    }
    content = `<skills>\n${lines.join("\n")}\n</skills>`;
  }

  const block: RenderedFragment = {
    tag: "core/system",
    content,
    source: "skills",
  };

  const emits: Element[] = [
    emitTool(skill_lookup),
    emitTool(skill_invoke),
    emitFragment(block),
  ];

  // Emit one command per (skill, command) pair. Names are flat: collisions
  // across skills are an operator concern. Description carries the skill
  // name in brackets so operators can disambiguate when listing commands.
  if (state.resolved) {
    for (const s of state.entries) {
      for (const c of s.commands) {
        const oneLine = c.prompt.replace(/\s+/g, " ").trim();
        const truncated =
          oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine;
        const prompt = c.prompt;
        emits.push(
          emitCommand({
            name: c.name,
            description: `[${s.name}] ${truncated}`,
            handler: ({ args, runtime }) => {
              runtime.appendUserMessage(
                `${prompt}${args ? `\n\n${args}` : ""}`,
              );
            },
          }),
        );
      }
    }
  }
  return emits as Node;
}
