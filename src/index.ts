// Standalone Effect-TS agent runtime package shared by the harness,
// smithery bridge, and local callers.
export {
  createAgent,
  createAgentRuntime,
  type Agent,
  type AgentOptions,
  type AgentSnapshot,
  type Extension,
} from "./core/agent";
export {
  AgentCtx,
  type AgentCtxService,
  type AgentCtxOptions,
  type AmbientProducer,
  type Transform,
  type TransformContext,
  type AgentErrorEntry,
  type ProjectionInputs,
  type Renderer,
} from "./core/agent-ctx";
export { PendingSends, type PendingSendsService } from "./core/pending-sends";
export { runInference } from "./core/inference";
export { runToolExecution } from "./core/tool-exec";
export { runHaltGate } from "./core/halt-gate";
export {
  isHalted,
  lastResult,
  pendingToolCallsFromLog,
  renderHistoryFragments,
  toolsInFlight,
} from "./core/projections";
export { makeEventLog, type EventLog, type EventInput } from "./core/event-log";
export { reconcileHydrationDangling } from "./core/hydration";
export {
  DuplicateToolError,
  InferenceError,
  ToolExecutionError,
  type AgentError,
} from "./core/errors";
export type {
  Fragment,
  FragmentMap,
  CacheControl,
  Event,
  InferFn,
  InferResponse,
  ProviderOptions,
  ProviderContext,
  ProviderMessage,
  ProviderContentChunk,
  Rendered,
  Tool,
  ToolCall,
  ToolContext,
  ToolDefinition,
} from "./core/types";
// JSX-context API root-level entry. Components live under
// `effectctx/components` (per the package.json exports map); the
// `render` function and types are re-exported here so callers using
// `context: () => render(<Agent>...)` can import everything they need
// from the package root.
export { render } from "./jsx";
export type { RenderContext } from "./jsx";
export {
  createAiGatewayInfer,
  createOpenRouterInfer,
  type AiGatewayOptions,
  type AiGatewayUsage,
  type OpenRouterOptions,
  type OpenRouterUsage,
  type SharedUsage,
} from "./providers";
export { defineTool, type DefineToolOptions } from "./core/define-tool";
export {
  ambientCwd,
  maxSteps,
  clipMessages,
  type ClipMessagesOptions,
  snip,
  type SnipOptions,
  truncateTools,
  type TruncateToolsOptions,
  estimateTokensFromFragments,
  fileSystem,
  type FileInfo,
  type FileStore,
  type FileSystemOptions,
  createInMemoryStore,
  type InMemoryStoreOptions,
  shell,
  type Shell,
  type ShellOptions,
  type ExecResult,
  workspace,
  type Workspace,
  type WorkspaceOptions,
  summarize,
  SUMMARIZATION_PROMPT,
  type SummarizeOptions,
  compact,
  type CompactOptions,
  recall,
  type RecallOptions,
  truncateToolOutputs,
  type TruncateToolOutputsOptions,
  webSearch,
  type WebSearchOptions,
  mcpServers,
  type McpServerSpec,
  type McpServersOptions,
  skills,
  type SkillEntry,
  type SkillBackend,
  type SkillsOptions,
  subagents,
  inProcessBackend,
  type SubagentBackend,
  type SubagentDef,
  type SubagentSpawnOpts,
  type SubagentTerminal,
  type SubagentsOptions,
} from "./extensions";
