// Node-specific helpers. Importing this subpath pulls in `node:fs/promises`
// and `node:child_process`, so it only resolves on Node-shaped runtimes.
// Worker / Deno / browser code should NOT import from `effectctx/node`.

export { nodeShell } from "./shell";
export { nodeFileStore } from "./file-store";
export { localWorkspace, type LocalWorkspaceOptions } from "./workspace";
