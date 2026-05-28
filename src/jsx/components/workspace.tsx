// Capability component — declares tools and an ambient fragment that
// grant the agent power over the local filesystem and shell. Real,
// platform-backed implementations: tool `run` bodies invoke Effect
// workflows that depend on `FileSystem`, `Path`, and `CommandExecutor`
// from `@effect/platform`. The agent runtime injects those services
// via `AgentOptions.platform`; `useRenderContext().runEffect` is the
// bridge that runs an Effect with `R = never` from the caller's
// perspective (the runtime has already provided the platform layer).

import { Command, FileSystem, Path } from "@effect/platform";
import { Effect, Schema, Stream } from "effect";
import { defineTool } from "../../core/define-tool";
import type { Fragment as RenderedFragment } from "../../core/types";
import { emitFragment, emitTool, type Element, type Node } from "../runtime";
import { useRenderContext } from "../render";

// ---------------------------------------------------------------------
// <Workspace root="..." />
//
// Declares 5 tools (bash, read_file, write_file, grep, list_dir) backed
// by real platform services and emits one ambient system block. The
// block intentionally does NOT contain a live tree snapshot — the
// render walk is synchronous and runEffect is async, so a live tree
// would require a forked fiber maintaining a snapshot Ref. Punted for
// now: the model uses `list_dir` to inspect on demand.
// ---------------------------------------------------------------------

export interface WorkspaceProps {
  readonly root: string;
}

export function Workspace(props: WorkspaceProps): Node {
  const { root } = props;
  const { runEffect } = useRenderContext();

  // Helper: run a `bash -c <cmd>` and return a string with stdout,
  // stderr, and exit code formatted for the LLM. Mirrors the
  // convention from `src/extensions/shell.ts` so the model sees a
  // consistent shape across the codebase.
  const runShell = (
    command: string,
  ): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path | import("@effect/platform/CommandExecutor").CommandExecutor> =>
    Effect.gen(function* () {
      const proc = yield* Command.make("bash", "-c", command).pipe(Command.start);
      const stdoutBytes = yield* proc.stdout.pipe(Stream.runCollect);
      const stderrBytes = yield* proc.stderr.pipe(Stream.runCollect);
      const exit = yield* proc.exitCode;
      const decoder = new TextDecoder();
      const decode = (
        chunks: import("effect/Chunk").Chunk<Uint8Array>,
      ): string => {
        // Concatenate Uint8Arrays then decode once. Simpler than
        // streaming-decode for the small outputs we expect.
        const arrays: Uint8Array[] = [];
        let total = 0;
        for (const c of chunks) {
          arrays.push(c);
          total += c.byteLength;
        }
        const merged = new Uint8Array(total);
        let off = 0;
        for (const a of arrays) {
          merged.set(a, off);
          off += a.byteLength;
        }
        return decoder.decode(merged);
      };
      const out = decode(stdoutBytes).trim();
      const err = decode(stderrBytes).trim();
      const parts: string[] = [];
      if (out) parts.push(out);
      if (err) parts.push(`[stderr]\n${err}`);
      parts.push(`[exit code: ${exit}]`);
      return parts.join("\n\n");
    }).pipe(
      Effect.scoped,
      Effect.catchAll((e) =>
        Effect.succeed(
          `[bash] Error: ${e instanceof Error ? e.message : String(e)}`,
        ),
      ),
    ) as Effect.Effect<
      string,
      never,
      FileSystem.FileSystem | Path.Path | import("@effect/platform/CommandExecutor").CommandExecutor
    >;

  const bash = defineTool({
    name: "bash",
    description: "Run a shell command in the workspace via `bash -c`. Returns stdout, stderr, and exit code.",
    parameters: Schema.Struct({
      command: Schema.String,
    }),
    run: async ({ command }) => {
      try {
        return await runEffect(
          runShell(command) as unknown as Effect.Effect<string, never, never>,
        );
      } catch (e) {
        return `[bash] Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  const read_file = defineTool({
    name: "read_file",
    description: "Read a file relative to the workspace root.",
    parameters: Schema.Struct({
      path: Schema.String,
    }),
    run: async ({ path }) => {
      try {
        return await runEffect(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const p = yield* Path.Path;
            const target = p.resolve(root, path);
            const exists = yield* fs.exists(target);
            if (!exists) return `File not found: ${path}`;
            return yield* fs.readFileString(target);
          }).pipe(
            Effect.catchAll((e) =>
              Effect.succeed(
                `[read_file] Error: ${e instanceof Error ? e.message : String(e)}`,
              ),
            ),
          ) as unknown as Effect.Effect<string, never, never>,
        );
      } catch (e) {
        return `[read_file] Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  const write_file = defineTool({
    name: "write_file",
    description:
      "Write a file relative to the workspace root. Creates parent directories as needed.",
    parameters: Schema.Struct({
      path: Schema.String,
      contents: Schema.String,
    }),
    run: async ({ path, contents }) => {
      try {
        return await runEffect(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const p = yield* Path.Path;
            const target = p.resolve(root, path);
            const dir = p.dirname(target);
            yield* fs.makeDirectory(dir, { recursive: true });
            yield* fs.writeFileString(target, contents);
            return `Wrote ${contents.length} chars to ${path}`;
          }).pipe(
            Effect.catchAll((e) =>
              Effect.succeed(
                `[write_file] Error: ${e instanceof Error ? e.message : String(e)}`,
              ),
            ),
          ) as unknown as Effect.Effect<string, never, never>,
        );
      } catch (e) {
        return `[write_file] Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  const grep = defineTool({
    name: "grep",
    description:
      "Recursively grep for a pattern under the workspace (or a subpath). Uses `grep -rIn`.",
    parameters: Schema.Struct({
      pattern: Schema.String,
      path: Schema.optional(Schema.String),
    }),
    run: async ({ pattern, path }) => {
      try {
        return await runEffect(
          Effect.gen(function* () {
            const p = yield* Path.Path;
            const target = p.resolve(root, path ?? "");
            const proc = yield* Command.make(
              "grep",
              "-rIn",
              pattern,
              target,
            ).pipe(Command.start);
            const stdoutBytes = yield* proc.stdout.pipe(Stream.runCollect);
            const exit = yield* proc.exitCode;
            const decoder = new TextDecoder();
            const arrays: Uint8Array[] = [];
            let total = 0;
            for (const c of stdoutBytes) {
              arrays.push(c);
              total += c.byteLength;
            }
            const merged = new Uint8Array(total);
            let off = 0;
            for (const a of arrays) {
              merged.set(a, off);
              off += a.byteLength;
            }
            const out = decoder.decode(merged);
            // grep exits 1 when there are no matches. Treat that as
            // empty result, not an error.
            if (exit === 1 && out.length === 0) {
              return `No matches for: ${pattern}`;
            }
            return out.length > 0 ? out : `No matches for: ${pattern}`;
          }).pipe(
            Effect.scoped,
            Effect.catchAll((e) =>
              Effect.succeed(
                `[grep] Error: ${e instanceof Error ? e.message : String(e)}`,
              ),
            ),
          ) as unknown as Effect.Effect<string, never, never>,
        );
      } catch (e) {
        return `[grep] Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  const list_dir = defineTool({
    name: "list_dir",
    description:
      "List entries in a directory relative to the workspace root. Directories show a trailing slash.",
    parameters: Schema.Struct({
      path: Schema.optional(Schema.String),
    }),
    run: async ({ path }) => {
      try {
        return await runEffect(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const p = yield* Path.Path;
            const target = p.resolve(root, path ?? "");
            const entries = yield* fs.readDirectory(target);
            const sorted = [...entries].sort();
            const lines: string[] = [];
            for (const name of sorted) {
              const full = p.resolve(target, name);
              const stat = yield* fs.stat(full).pipe(
                Effect.catchAll(() =>
                  Effect.succeed({ type: "File" as const }),
                ),
              );
              lines.push(
                stat.type === "Directory" ? `${name}/` : name,
              );
            }
            return lines.join("\n");
          }).pipe(
            Effect.catchAll((e) =>
              Effect.succeed(
                `[list_dir] Error: ${e instanceof Error ? e.message : String(e)}`,
              ),
            ),
          ) as unknown as Effect.Effect<string, never, never>,
        );
      } catch (e) {
        return `[list_dir] Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  const block: RenderedFragment = {
    tag: "core/system",
    content: `<workspace root="${root}">\n  (use list_dir to inspect)\n</workspace>`,
    source: "workspace",
  };

  const emits: Element[] = [
    emitTool(bash),
    emitTool(read_file),
    emitTool(write_file),
    emitTool(grep),
    emitTool(list_dir),
    emitFragment(block),
  ];
  return emits as Node;
}
