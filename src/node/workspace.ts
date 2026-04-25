import type { Extension } from "../agent";
import { workspace, type WorkspaceOptions } from "../extensions/workspace";
import { nodeFileStore } from "./file-store";
import { nodeShell } from "./shell";

export interface LocalWorkspaceOptions extends WorkspaceOptions {
  readonly root: string;
}

// Node-flavored shorthand for `workspace(...)`. Builds a host-process
// Shell + real-disk FileStore rooted at `root`, then hands them to the
// underlying `workspace` extension. Use directly for local dev. For
// production, write your own adapters (sandbox, container, etc.) and
// call the underlying `workspace(...)` directly.
export const localWorkspace = (opts: LocalWorkspaceOptions): Extension => {
  const { root, ...rest } = opts;
  return workspace(
    { root, shell: nodeShell(), fs: nodeFileStore(root) },
    rest,
  );
};
