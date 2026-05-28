import { Effect, Layer, Ref, Schema } from "effect";
import { AgentCtx } from "../core/agent-ctx";
import type { Extension } from "../core/agent";
import { registerTool } from "./tool-registration";
import { renderTree } from "./file-system-tree";

// A file store backend. The `fileSystem()` extension ships the tools
// and the ambient workspace block; the backend supplies storage.
//
// Security contract — path scoping is the ADAPTER's responsibility.
// The `fileSystem()` extension deliberately does not validate paths:
// whatever the LLM produces is passed straight through. Adapters
// over real filesystems MUST resolve paths against a fixed root and
// reject traversal; per-sandbox adapters inherit isolation from the
// container; global-namespace adapters MUST prefix every path with a
// per-session root. Silent pass-through is a security bug.
export interface FileInfo {
  path: string;
  size: number;
  type: "file" | "dir";
}

export interface FileStore {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  list(dir?: string, opts?: { limit?: number; offset?: number }): Promise<FileInfo[]>;
  delete(path: string, opts?: { recursive?: boolean }): Promise<void>;
  glob(pattern: string): Promise<FileInfo[]>;
  stat(path: string): Promise<FileInfo | null>;
}

export interface FileSystemOptions {
  maxTreeFiles?: number;
  maxTreeDepth?: number;
  // Path-segment patterns to hide from the projected tree. Each string
  // matches an exact directory / file name at any depth. Tools still
  // operate on these paths — the ignore list only affects ambient view.
  ignore?: string[];
}

const DEFAULT_IGNORE = [
  "node_modules",
  ".git",
  ".turbo",
  ".next",
  ".nuxt",
  ".vercel",
  "dist",
  "build",
  "out",
  ".cache",
  ".DS_Store",
  "coverage",
];

export const fileSystem = (
  store: FileStore,
  opts: FileSystemOptions = {},
): Extension => {
  const maxTreeFiles = opts.maxTreeFiles ?? 50;
  const maxTreeDepth = opts.maxTreeDepth ?? 4;
  const ignore = new Set(opts.ignore ?? DEFAULT_IGNORE);

  return Layer.scopedDiscard(
    Effect.gen(function* () {
      const ctx = yield* AgentCtx;

      // Local cache of the current listing. write_file / delete_file
      // refresh it synchronously inside the tool's Promise so by the
      // time the tool.result event lands the cache reflects the new
      // state.
      const listingRef = yield* Ref.make<FileInfo[]>([]);

      const refresh = (): Promise<void> =>
        store
          .list()
          .then(
            (entries) => Effect.runPromise(Ref.set(listingRef, entries)),
            (err) =>
              Effect.runPromise(ctx.reportError("file-system", err)).then(() => {
                const g = globalThis as {
                  console?: { error?: (...args: unknown[]) => void };
                };
                g.console?.error?.("[file-system] list() failed:", err);
              }),
          );

      yield* Effect.promise(() => refresh());

      yield* ctx.addAmbient({
        name: "workspace",
        content: Effect.gen(function* () {
          const files = yield* Ref.get(listingRef);
          if (files.length === 0) return "## Workspace: empty";
          return renderTree(files, { maxTreeFiles, maxTreeDepth, ignore });
        }),
      });

      yield* registerTool(ctx, "file-system", {
        name: "read_file",
        description:
          "Read the contents of a file from the workspace. Returns the file content as a string, or a not-found message if the path does not exist.",
        parameters: Schema.Struct({
          path: Schema.String.annotations({
            description:
              "File path, relative to the workspace root. Do not start with `/`.",
          }),
        }),
        run: async (args) => {
          const content = await store.read(args.path);
          return content ?? `File not found: ${args.path}`;
        },
      });

      yield* registerTool(ctx, "file-system", {
        name: "write_file",
        description:
          "Write a file to the workspace. Creates the file if it doesn't exist, overwrites if it does.",
        parameters: Schema.Struct({
          path: Schema.String.annotations({
            description:
              "File path, relative to the workspace root. Do not start with `/`.",
          }),
          content: Schema.String.annotations({ description: "File content." }),
        }),
        run: async (args) => {
          await store.write(args.path, args.content);
          await refresh();
          return `Wrote ${args.path}`;
        },
      });

      yield* registerTool(ctx, "file-system", {
        name: "list_files",
        description:
          "List files in the workspace. Optionally scope to a directory or paginate large listings.",
        parameters: Schema.Struct({
          dir: Schema.String.annotations({
            description:
              "Directory to list, relative to the workspace root (no leading `/`). Omit for the workspace root.",
          }).pipe(Schema.optionalWith({ nullable: true })),
          limit: Schema.Number.annotations({
            description: "Maximum entries to return.",
          }).pipe(Schema.optionalWith({ nullable: true })),
          offset: Schema.Number.annotations({
            description: "Number of entries to skip.",
          }).pipe(Schema.optionalWith({ nullable: true })),
        }),
        run: async (args) => {
          const entries = await store.list(args.dir, {
            limit: args.limit,
            offset: args.offset,
          });
          return JSON.stringify(entries, null, 2);
        },
      });

      yield* registerTool(ctx, "file-system", {
        name: "delete_file",
        description:
          "Delete a file from the workspace. Pass recursive: true to delete a directory and its contents.",
        parameters: Schema.Struct({
          path: Schema.String.annotations({
            description:
              "File path, relative to the workspace root. Do not start with `/`.",
          }),
          recursive: Schema.Boolean.annotations({
            description: "Delete directories recursively. Default false.",
          }).pipe(Schema.optionalWith({ nullable: true })),
        }),
        run: async (args) => {
          await store.delete(args.path, { recursive: args.recursive ?? false });
          await refresh();
          return `Deleted ${args.path}`;
        },
      });

      yield* registerTool(ctx, "file-system", {
        name: "glob_files",
        description:
          "Find files matching a glob pattern (e.g. '**/*.ts'). Useful when you know a pattern but not exact paths.",
        parameters: Schema.Struct({
          pattern: Schema.String.annotations({
            description:
              "Glob pattern relative to the workspace root (no leading `/`). E.g. 'src/**/*.ts'.",
          }),
        }),
        run: async (args) => {
          const matches = await store.glob(args.pattern);
          return JSON.stringify(matches, null, 2);
        },
      });

      yield* registerTool(ctx, "file-system", {
        name: "stat_file",
        description:
          "Get metadata (size, type) for a file or directory. Returns null if the path does not exist.",
        parameters: Schema.Struct({
          path: Schema.String.annotations({
            description:
              "File path, relative to the workspace root. Do not start with `/`.",
          }),
        }),
        run: async (args) => {
          const info = await store.stat(args.path);
          return info ? JSON.stringify(info) : "File not found";
        },
      });
    }),
  );
};
