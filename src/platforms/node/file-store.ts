import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat as fsStat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { FileInfo, FileStore } from "../../extensions/file-system";

// Real-disk FileStore scoped to a single root directory. Path arguments
// from the model are joined under `root`, so the agent can't escape the
// workspace by asking for `/etc/passwd`.
export const nodeFileStore = (root: string): FileStore => {
  const abs = (p: string) => resolve(root, p.replace(/^\//, ""));
  const rel = (p: string) => relative(root, p) || ".";
  const info = async (p: string): Promise<FileInfo | null> => {
    try {
      const s = await fsStat(p);
      return {
        path: rel(p),
        size: s.size,
        type: s.isDirectory() ? "dir" : "file",
      };
    } catch {
      return null;
    }
  };
  return {
    read: async (path) => {
      try {
        return await readFile(abs(path), "utf8");
      } catch {
        return null;
      }
    },
    write: async (path, content) => {
      const target = abs(path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    },
    list: async (dir = "/") => {
      const target = abs(dir);
      const entries = await readdir(target, { withFileTypes: true });
      const out: FileInfo[] = [];
      for (const e of entries) {
        const item = await info(join(target, e.name));
        if (item) out.push(item);
      }
      return out;
    },
    delete: async (path, opts) =>
      rm(abs(path), { recursive: !!opts?.recursive, force: true }),
    glob: async () => [],
    stat: async (path) => info(abs(path)),
  };
};
