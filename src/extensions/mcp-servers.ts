import { Effect, Layer, Scope } from "effect";
import { AgentCtx, type AgentCtxService } from "../core/agent-ctx";
import type { Extension } from "../core/agent";
import type { Tool } from "../core/types";
import { addToolReporting } from "./tool-registration";

// Spec for one MCP server the harness should connect to.
export type McpServerSpec =
  | {
      name: string;
      transport: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      name: string;
      transport: "http";
      url: string;
      headers?: Record<string, string>;
    };

export interface McpServersOptions {
  servers: McpServerSpec[];
  // Called when each server finishes `tools/list` registration. Useful
  // for surfacing progress in a CLI banner. Optional.
  onConnected?: (name: string, toolCount: number) => void;
  // Called when a server fails to connect. Default: log to console.
  onError?: (name: string, err: Error) => void;
}

// Connects to a list of MCP servers, enumerates their tools, and
// registers each remote tool as a harness tool. Tool names are
// namespaced as `<server>__<tool>` so multiple servers can expose the
// same tool name without collision.
//
// Init is async but fire-and-forget from the extension's POV. Tools
// appear in the harness toolbox as soon as each server's `tools/list`
// resolves — the first inference may run before some servers are
// ready. Callers who want all tools visible before the first turn
// should pass `onConnected` and gate their initial send on completion.
//
// On scope close, each MCP client is closed via an explicit finalizer.
export const mcpServers = (opts: McpServersOptions): Extension => {
  const {
    servers,
    onConnected,
    onError = (name, err): void => {
      const g = globalThis as { console?: { error?: (...args: unknown[]) => void } };
      g.console?.error?.(`[mcp:${name}] failed: ${err.message}`);
    },
  } = opts;

  return Layer.scopedDiscard(
    Effect.gen(function* () {
      const ctx = yield* AgentCtx;
      const scope = yield* Effect.scope;
      for (const spec of servers) {
        yield* Effect.forkScoped(
          connectServer(spec, ctx, scope, onConnected, onError),
        );
      }
    }),
  );
};

const connectServer = (
  spec: McpServerSpec,
  ctx: AgentCtxService,
  scope: Scope.Scope,
  onConnected: McpServersOptions["onConnected"],
  onError: NonNullable<McpServersOptions["onError"]>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const clientResult = yield* Effect.tryPromise({
      try: async () => {
        // Dynamic imports — the MCP SDK ships child_process / ajv /
        // real-Node surfaces. Keeping these behind `import()` defers
        // module resolution until the extension is actually used, so
        // sandbox hosts that never invoke `mcpServers()` don't need
        // the SDK at all.
        const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
        const client = new Client(
          { name: "flamecast-harness", version: "0.0.0" },
          { capabilities: {} },
        );
        if (spec.transport === "stdio") {
          const { StdioClientTransport } = await import(
            "@modelcontextprotocol/sdk/client/stdio.js"
          );
          await client.connect(
            new StdioClientTransport({
              command: spec.command,
              args: spec.args ?? [],
              env: spec.env,
            }),
          );
        } else {
          const { StreamableHTTPClientTransport } = await import(
            "@modelcontextprotocol/sdk/client/streamableHttp.js"
          );
          await client.connect(
            new StreamableHTTPClientTransport(new URL(spec.url), {
              requestInit: spec.headers ? { headers: spec.headers } : undefined,
            }),
          );
        }
        const listing = await client.listTools();
        return { client, tools: listing.tools };
      },
      catch: (e) => (e instanceof Error ? e : new Error(String(e))),
    }).pipe(Effect.either);

    if (clientResult._tag === "Left") {
      onError(spec.name, clientResult.left);
      yield* ctx.reportError("mcp_servers", clientResult.left);
      return;
    }

    const { client, tools } = clientResult.right;

    // Close the client when the extension's scope closes.
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        void client.close().catch(() => {});
      }),
    );

    for (const t of tools) {
      const harnessTool: Tool = {
        name: `${spec.name}__${t.name}`,
        description: `[mcp:${spec.name}] ${t.description ?? t.name}`,
        parameters: isRecord(t.inputSchema)
          ? t.inputSchema
          : { type: "object", properties: {} },
        run: async (args) => {
          try {
            const result = await client.callTool({
              name: t.name,
              arguments: args,
            });
            const content = Array.isArray(result.content) ? result.content : [];
            const parts: string[] = [];
            for (const block of content) {
              if (isTextBlock(block)) {
                parts.push(block.text);
              } else {
                parts.push(JSON.stringify(block));
              }
            }
            if (result.isError) {
              return `Error from ${spec.name}__${t.name}: ${parts.join("\n")}`;
            }
            return parts.join("\n") || "(no content)";
          } catch (e) {
            return `Error: ${e instanceof Error ? e.message : String(e)}`;
          }
        },
      };
      yield* addToolReporting(ctx, "mcp_servers", harnessTool).pipe(
        Scope.extend(scope),
      );
    }

    onConnected?.(spec.name, tools.length);
  });

// Narrow an unknown inputSchema to a plain record without asserting.
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isTextBlock = (v: unknown): v is { type: "text"; text: string } =>
  isRecord(v) && v.type === "text" && typeof v.text === "string";
