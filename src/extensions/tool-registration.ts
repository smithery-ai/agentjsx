import { Effect, type Scope } from "effect";
import type { AgentCtxService } from "../core/agent-ctx";
import { defineTool, type DefineToolOptions } from "../core/define-tool";
import type { Tool } from "../core/types";

// Extensions register tools via `ctx.addTool`, which fails with
// DuplicateToolError when two extensions share a name. Extensions
// surface that as a reported error so the operator sees the collision
// without crashing the agent.
export const addToolReporting = (
  ctx: AgentCtxService,
  phase: string,
  tool: Tool,
): Effect.Effect<void, never, Scope.Scope> =>
  ctx.addTool(tool).pipe(
    Effect.catchTag("DuplicateToolError", (err) =>
      ctx.reportError(phase, err),
    ),
  );

// Typed-tool registration: defineTool + addToolReporting in one step.
// Use this for hand-written tools. MCP-forwarded tools with raw JSON
// Schema go through `addToolReporting` directly.
export const registerTool = <A>(
  ctx: AgentCtxService,
  phase: string,
  opts: DefineToolOptions<A>,
): Effect.Effect<void, never, Scope.Scope> =>
  addToolReporting(ctx, phase, defineTool(opts));
