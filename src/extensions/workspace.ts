import { Layer } from "effect";
import type { Extension } from "../core/agent";
import { fileSystem, type FileStore, type FileSystemOptions } from "./file-system";
import { shell, type Shell, type ShellOptions } from "./shell";

// A `Workspace` bundles the shell and filesystem backends at a single
// `root`. Installing it via `workspace(ws)` guarantees bash's cwd and
// the filesystem extension's rooting are the same directory — the LLM
// gets one coherent "where am I" answer across both tool surfaces.
//
// When you genuinely want them decoupled (bash-only automation, a
// virtual fs with no shell, or two different roots), install `shell()`
// or `fileSystem()` directly instead.
export interface Workspace {
  readonly root: string;
  readonly shell: Shell;
  readonly fs: FileStore;
}

export interface WorkspaceOptions {
  readonly shell?: Omit<ShellOptions, "cwd">;
  readonly fileSystem?: FileSystemOptions;
}

// Install shell + fileSystem rooted at a single workspace. Shell's
// initial cwd is `ws.root` so `bash(pwd)` matches the filesystem's
// root, and `bash(cat x)` / `read_file("x")` read the same file.
export const workspace = (
  ws: Workspace,
  opts: WorkspaceOptions = {},
): Extension =>
  Layer.mergeAll(
    shell(ws.shell, { cwd: ws.root, ...opts.shell }),
    fileSystem(ws.fs, opts.fileSystem),
  );
