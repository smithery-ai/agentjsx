// Platform-agnostic runtime guts. Re-exports the core surface so callers
// can `import { ... } from "@flamecast/agentjsx/core"` without reaching
// into individual files.
export * from "./agent";
export * from "./agent-ctx";
export * from "./compaction";
export * from "./define-tool";
export * from "./errors";
export * from "./event-log";
export * from "./hydration";
export * from "./inference";
export * from "./pending-sends";
export * from "./projections";
export * from "./render-adapter";
export * from "./tool-exec";
export * from "./types";
export * from "./validate";
