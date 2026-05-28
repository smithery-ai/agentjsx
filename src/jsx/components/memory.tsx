// Capability component — persistent cross-conversation memory backed by
// a directory on disk. Three tools (memory_read / memory_write /
// memory_list) plus a one-line ambient block telling the model where
// memory lives and how to use it.
//
// Design note: this is a thin filesystem capability. There is no
// auto-loading of a top-level index file at render time (that would
// require the MCP-style async cache pattern); the model is expected to
// call `memory_list` (or `memory_read` of a known index) on its first
// turn if it wants to discover existing memory. Operators who want
// always-loaded memory can compose with `<Block name="memory">` and
// pre-read the index themselves.
//
// Path safety: tool args are resolved relative to `root` and rejected if
// they escape via `..`. The check is string-prefix on the resolved
// path; the platform layer does not currently expose `realpath`.

import { FileSystem, Path } from "@effect/platform";
import { Effect, Schema } from "effect";
import { defineTool } from "../../core/define-tool";
import type { Fragment as RenderedFragment } from "../../core/types";
import { emitFragment, emitTool, type Element, type Node } from "../runtime";
import { useRenderContext } from "../render";

export interface MemoryProps {
  // Directory where memory files live. Created on first write if absent.
  readonly root: string;
}

// Resolve `path` against `root` and reject escapes. Returns the absolute
// target, or `null` if the path is outside the memory root. Uses string
// prefix on the resolved path; the platform layer does not currently
// expose realpath.
function safeResolve(
  resolve: (...parts: string[]) => string,
  sep: string,
  root: string,
  path: string,
): string | null {
  const absRoot = resolve(root);
  const target = resolve(absRoot, path);
  if (target !== absRoot && !target.startsWith(absRoot + sep)) {
    return null;
  }
  return target;
}

export function Memory(props: MemoryProps): Node {
  const { root } = props;
  const { runEffect } = useRenderContext();

  const memory_read = defineTool({
    name: "memory_read",
    description:
      "Read a memory file by path (relative to the memory root). Returns the file contents.",
    parameters: Schema.Struct({
      path: Schema.String,
    }),
    run: async ({ path }) => {
      try {
        return await runEffect(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const p = yield* Path.Path;
            const target = safeResolve(
              (...parts: string[]) => p.resolve(...parts),
              p.sep,
              root,
              path,
            );
            if (target === null) {
              return `Error: path "${path}" escapes the memory root.`;
            }
            const exists = yield* fs.exists(target);
            if (!exists) return `Memory not found: ${path}`;
            return yield* fs.readFileString(target);
          }).pipe(
            Effect.catchAll((e) =>
              Effect.succeed(
                `[memory_read] Error: ${e instanceof Error ? e.message : String(e)}`,
              ),
            ),
          ) as unknown as Effect.Effect<string, never, never>,
        );
      } catch (e) {
        return `[memory_read] Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  const memory_write = defineTool({
    name: "memory_write",
    description:
      "Write a memory file (relative to the memory root). Creates parent directories as needed. Overwrites if the file exists.",
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
            const target = safeResolve(
              (...parts: string[]) => p.resolve(...parts),
              p.sep,
              root,
              path,
            );
            if (target === null) {
              return `Error: path "${path}" escapes the memory root.`;
            }
            const dir = p.dirname(target);
            yield* fs.makeDirectory(dir, { recursive: true });
            yield* fs.writeFileString(target, contents);
            return `Wrote ${contents.length} chars to ${path}`;
          }).pipe(
            Effect.catchAll((e) =>
              Effect.succeed(
                `[memory_write] Error: ${e instanceof Error ? e.message : String(e)}`,
              ),
            ),
          ) as unknown as Effect.Effect<string, never, never>,
        );
      } catch (e) {
        return `[memory_write] Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  const memory_list = defineTool({
    name: "memory_list",
    description:
      "Recursively list memory files. Returns one path per line, relative to the memory root.",
    parameters: Schema.Struct({}),
    run: async () => {
      try {
        return await runEffect(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const p = yield* Path.Path;
            const absRoot = p.resolve(root);
            const exists = yield* fs.exists(absRoot);
            if (!exists) return "(memory directory does not exist yet)";
            const out: string[] = [];
            const walkDir = (
              dir: string,
            ): Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path> =>
              Effect.gen(function* () {
                const entries = yield* fs.readDirectory(dir);
                for (const name of [...entries].sort()) {
                  const full = p.resolve(dir, name);
                  const stat = yield* fs.stat(full).pipe(
                    Effect.catchAll(() =>
                      Effect.succeed({ type: "File" as const }),
                    ),
                  );
                  if (stat.type === "Directory") {
                    yield* walkDir(full);
                  } else {
                    out.push(p.relative(absRoot, full));
                  }
                }
              });
            yield* walkDir(absRoot);
            return out.length === 0 ? "(empty)" : out.join("\n");
          }).pipe(
            Effect.catchAll((e) =>
              Effect.succeed(
                `[memory_list] Error: ${e instanceof Error ? e.message : String(e)}`,
              ),
            ),
          ) as unknown as Effect.Effect<string, never, never>,
        );
      } catch (e) {
        return `[memory_list] Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  const block: RenderedFragment = {
    tag: "core/system",
    content:
      `<memory root="${root}">\n` +
      "  Persistent across conversations. Use memory_list to discover, memory_read to load, memory_write to save.\n" +
      "</memory>",
    source: "memory",
  };

  const emits: Element[] = [
    emitTool(memory_read),
    emitTool(memory_write),
    emitTool(memory_list),
    emitFragment(block),
  ];
  return emits as Node;
}
