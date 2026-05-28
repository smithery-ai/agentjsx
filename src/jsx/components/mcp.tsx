// Capability component — connects to a remote MCP (Model Context
// Protocol) server, lists its tools, and registers each as a harness
// tool. URL-based (streamableHttp) servers only for MVP; stdio
// (command-based) servers are a follow-up. The full extension at
// `src/extensions/mcp-servers.ts` supports both transports and proper
// scope-based cleanup; this JSX port trades that for the cache-with-
// fire-and-forget shape used by `<Skills>`.
//
// Synchronous-render constraint: same as `<Skills>`. The JSX walk is
// synchronous but connecting to an MCP server and listing tools is
// async via `runEffect`. We use a module-level cache keyed by
// `${name}::${url}`. First render seeds `state: "loading"` and kicks
// off a fire-and-forget connection. The next natural render (next
// agent event) after the connection resolves sees `state: "ready"` and
// emits the discovered tools.
//
// Tool namespacing: every discovered tool is registered as
// `<name>_<tool>` so multiple `<McpServer>`s mounted in the same agent
// don't collide. (The extension uses `<name>__<tool>` with a double
// underscore; the spec for this component calls for a single
// underscore. Both forms are fine — they're separate identifiers in
// separate code paths.)
//
// Lifecycle caveat: MCP clients created here are NOT closed in this
// MVP. The cache outlives any single `createAgentRuntime` instance
// (it's module-scoped, intentional — MCP clients are expensive and
// multiple runtimes in the same process should share). A proper
// Scope-based cleanup hook is a follow-up; for now clients leak across
// agent dispose within a process lifetime.

import { Effect } from "effect";
import type { Fragment as RenderedFragment, Tool } from "../../types";
import { emitFragment, emitTool, type Element, type Node } from "../runtime";
import { useRenderContext } from "../render";

// Minimal structural type for an MCP client. The real type comes from
// `@modelcontextprotocol/sdk/client/index.js` but we only touch
// `callTool` and `close` after construction, so a narrow interface
// keeps this file's surface honest.
interface McpClient {
  callTool(args: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<{ content?: unknown; isError?: boolean }>;
  close(): Promise<void>;
}

interface ToolMeta {
  name: string; // remote (un-prefixed) name
  description: string;
  inputSchema: Record<string, unknown>;
}

interface CacheState {
  state: "loading" | "ready" | "failed";
  tools: ToolMeta[];
  client?: McpClient;
  error?: string;
}

// Module-level cache keyed by `${name}::${url}`. Survives the lifetime
// of the JS module. Multiple `createAgentRuntime` instances in the
// same process intentionally share — see file-level comment.
const cache = new Map<string, CacheState>();

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isTextBlock = (v: unknown): v is { type: "text"; text: string } =>
  isRecord(v) && v.type === "text" && typeof v.text === "string";

// Async connection workflow. Wrapped as an Effect so it slots into the
// component's `runEffect` bridge cleanly. Returns either the client +
// listed tools or a failure marker; errors are flattened into the
// success channel so `runEffect`'s `R = never, E = never` contract is
// preserved.
function connectAndList(
  url: string,
  headers: McpHeaders | undefined,
): Effect.Effect<
  | { ok: true; client: McpClient; tools: ToolMeta[] }
  | { ok: false; error: string },
  never,
  never
> {
  return Effect.tryPromise({
    try: async (): Promise<
      | { ok: true; client: McpClient; tools: ToolMeta[] }
      | { ok: false; error: string }
    > => {
      // Dynamic imports mirror the pattern in
      // `src/extensions/mcp-servers.ts` — defers MCP SDK resolution
      // until something actually mounts an `<McpServer>`.
      const { Client } = await import(
        "@modelcontextprotocol/sdk/client/index.js"
      );
      const { StreamableHTTPClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/streamableHttp.js"
      );
      const client = new Client(
        { name: "effectctx-jsx-mcp", version: "0.0.0" },
        { capabilities: {} },
      ) as unknown as McpClient & {
        connect(t: unknown): Promise<void>;
        listTools(): Promise<{ tools: unknown[] }>;
      };
      // Resolve thunk form (sync or async) so callers can rotate
      // tokens without remounting. Static objects pass through.
      const resolvedHeaders =
        typeof headers === "function" ? await headers() : headers;
      await client.connect(
        new StreamableHTTPClientTransport(new URL(url), {
          requestInit: resolvedHeaders ? { headers: resolvedHeaders } : undefined,
        }),
      );
      const listing = await client.listTools();
      const tools: ToolMeta[] = [];
      for (const raw of listing.tools) {
        if (!isRecord(raw)) continue;
        const name =
          typeof raw.name === "string" ? raw.name : undefined;
        if (!name) continue;
        const description =
          typeof raw.description === "string" ? raw.description : name;
        const inputSchema = isRecord(raw.inputSchema)
          ? raw.inputSchema
          : { type: "object", properties: {} };
        tools.push({ name, description, inputSchema });
      }
      return { ok: true, client, tools };
    },
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  }).pipe(
    Effect.catchAll((e) =>
      Effect.succeed({ ok: false as const, error: e.message }),
    ),
  );
}

// Headers sent on every HTTP request to the MCP server. A plain
// `Record<string, string>` covers `Authorization: Bearer ...` and
// API-key cases; a sync/async thunk supports token rotation at
// connect time. The thunk runs once when the cache misses — the
// cached client reuses its initial headers across renders, so per-
// request rotation is a follow-up (requires a `fetch` override on
// the transport). We deliberately type this as `Record<string,
// string>` rather than the DOM `HeadersInit` global to keep this
// file lib-agnostic (the project's tsconfig doesn't include DOM).
export type McpHeadersValue = Record<string, string>;
export type McpHeaders =
  | McpHeadersValue
  | (() => McpHeadersValue | Promise<McpHeadersValue>);

export interface McpServerProps {
  readonly name: string;
  readonly url: string;
  // HTTP headers for `Authorization: Bearer ...` / API-key auth.
  // Forwarded into the SDK transport's `requestInit.headers`.
  readonly headers?: McpHeaders;
  // stdio (command-based) servers are deliberately omitted in this
  // MVP. The full extension at `src/extensions/mcp-servers.ts`
  // supports them; a follow-up can extend this component to accept a
  // `command`-discriminated variant.
}

export function McpServer(props: McpServerProps): Node {
  const { name, url, headers } = props;
  const { runEffect } = useRenderContext();
  // Cache key intentionally excludes `headers`: two `<McpServer>`s
  // with the same name+url but different headers will share the first-
  // connected client (one wins). In practice operators don't mount two
  // servers at the same URL with divergent auth. Follow-up: hash
  // resolved headers into the key if that assumption breaks.
  const key = `${name}::${url}`;

  let state = cache.get(key);
  if (!state) {
    state = { state: "loading", tools: [] };
    cache.set(key, state);
    // Fire-and-forget. The render walk doesn't await this; the next
    // natural render after this resolves will see the updated state.
    void runEffect(
      connectAndList(url, headers) as unknown as Effect.Effect<
        | { ok: true; client: McpClient; tools: ToolMeta[] }
        | { ok: false; error: string },
        never,
        never
      >,
    )
      .then((result) => {
        if (result.ok) {
          cache.set(key, {
            state: "ready",
            tools: result.tools,
            client: result.client,
          });
        } else {
          cache.set(key, {
            state: "failed",
            tools: [],
            error: result.error,
          });
        }
      })
      .catch((e: unknown) => {
        cache.set(key, {
          state: "failed",
          tools: [],
          error: e instanceof Error ? e.message : String(e),
        });
      });
  }

  const emits: Element[] = [];

  // Build harness tools for whatever's in the cache. In the "ready"
  // state this is the discovered set; in "loading" / "failed" it's
  // empty. The tool builder closes over the cached client; if a tool
  // is called before the client is populated, it returns an error
  // string — but in practice the model can only call tools it sees,
  // and tools only get emitted once the client is present.
  if (state.state === "ready" && state.client) {
    const client = state.client;
    for (const t of state.tools) {
      const harnessTool: Tool = {
        name: `${name}_${t.name}`,
        description: `[mcp:${name}] ${t.description}`,
        parameters: t.inputSchema,
        run: async (args) => {
          try {
            const result = await client.callTool({
              name: t.name,
              arguments: args,
            });
            const content = Array.isArray(result.content)
              ? result.content
              : [];
            const parts: string[] = [];
            for (const block of content) {
              if (isTextBlock(block)) {
                parts.push(block.text);
              } else {
                parts.push(JSON.stringify(block));
              }
            }
            if (result.isError) {
              return `[${name}_${t.name}] Error: ${parts.join("\n")}`;
            }
            return parts.join("\n") || "(no content)";
          } catch (e) {
            return `[${name}_${t.name}] Error: ${
              e instanceof Error ? e.message : String(e)
            }`;
          }
        },
      };
      emits.push(emitTool(harnessTool));
    }
  }

  let content: string;
  if (state.state === "loading") {
    content = `<mcp name="${name}">\n(connecting to ${url}...)\n</mcp>`;
  } else if (state.state === "failed") {
    content = `<mcp name="${name}">\nConnection failed: ${
      state.error ?? "(unknown error)"
    }\n</mcp>`;
  } else if (state.tools.length === 0) {
    content = `<mcp name="${name}">\n(no tools)\n</mcp>`;
  } else {
    const names = state.tools.map((t) => `${name}_${t.name}`).join(", ");
    content = `<mcp name="${name}">\nTools available: ${names}\n</mcp>`;
  }

  const block: RenderedFragment = {
    tag: "core/system",
    content,
    source: `mcp:${name}`,
  };
  emits.push(emitFragment(block));

  return emits as Node;
}

// Test-only escape hatch. Not part of the public API; do not import in
// user code. Stage 2b uses this to bypass the SDK round-trip in tests by
// pre-seeding the module-level cache with a fake client + tool listing.
export const __testing__ = {
  reset(): void {
    cache.clear();
  },
  seed(
    name: string,
    url: string,
    tools: ReadonlyArray<ToolMeta>,
    callTool: McpClient["callTool"],
  ): void {
    const client: McpClient = {
      callTool,
      close: async () => {},
    };
    cache.set(`${name}::${url}`, {
      state: "ready",
      tools: tools.map((t) => ({ ...t })),
      client,
    });
  },
};
