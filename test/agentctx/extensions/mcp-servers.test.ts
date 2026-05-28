// Wiring test for mcpServers() — spins up a local MCP server over HTTP,
// points the extension at it, and asserts that its tool appears in the
// harness toolbox and that LLM-side dispatch round-trips through the
// MCP protocol.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { createAgentRuntime, mcpServers } from "@flamecast/agentjsx";
import type { Event, InferFn } from "@flamecast/agentjsx";

interface ServerHandle {
  url: string;
  stop: () => Promise<void>;
}

const startLocalMcpHttp = async (): Promise<ServerHandle> => {
  const mcp = new McpServer({ name: "test-mcp", version: "0.0.1" });
  mcp.registerTool(
    "echo",
    {
      title: "Echo",
      description: "Echo the input back.",
      inputSchema: { text: z.string() },
    },
    async ({ text }) => ({
      content: [{ type: "text", text: `echoed: ${text}` }],
    }),
  );

  const transports = new Map<string, StreamableHTTPServerTransport>();

  const http: Server = createServer(async (req, res) => {
    try {
      const sid = (req.headers["mcp-session-id"] as string | undefined) ?? undefined;
      let transport: StreamableHTTPServerTransport | undefined = sid
        ? transports.get(sid)
        : undefined;
      if (!transport) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newId) => {
            if (transport) transports.set(newId, transport);
          },
        });
        await mcp.connect(transport);
      }
      await transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(err));
    }
  });

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const addr = http.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}/mcp`;

  return {
    url,
    stop: async () => {
      for (const t of transports.values()) {
        try {
          await t.close();
        } catch {}
      }
      transports.clear();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
};

describe("agentctx: mcpServers extension (http transport)", () => {
  let handle: ServerHandle;

  beforeEach(async () => {
    handle = await startLocalMcpHttp();
  });
  afterEach(async () => {
    await handle.stop();
  });

  it("registers remote tools with <server>__<tool> namespacing and dispatches them", async () => {
    const connected: Array<{ name: string; count: number }> = [];
    let capturedTools: string[] = [];
    let callIdx = 0;

    const infer: InferFn = async (context) => {
      capturedTools = context.tools.map((t) => t.name);
      if (callIdx++ === 0) {
        return {
          content: "",
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: {
                name: "test__echo",
                arguments: JSON.stringify({ text: "hello mcp" }),
              },
            },
          ],
        };
      }
      return { content: "done" };
    };

    const errors: Array<{ name: string; message: string }> = [];
    const agent = createAgentRuntime({
      infer,
      extensions: [
        mcpServers({
          servers: [{ name: "test", transport: "http", url: handle.url }],
          onConnected: (name, count) => connected.push({ name, count }),
          onError: (name, err) => errors.push({ name, message: err.message }),
        }),
      ],
    });

    try {
      // Wait for async registration.
      await new Promise<void>((resolve) => {
        const t0 = Date.now();
        const poll = setInterval(() => {
          if (connected.length > 0 || errors.length > 0 || Date.now() - t0 > 10_000) {
            clearInterval(poll);
            resolve();
          }
        }, 50);
      });
      expect(
        connected,
        `mcp server must connect; connected=${JSON.stringify(connected)} errors=${JSON.stringify(errors)}`,
      ).toHaveLength(1);
      expect(connected[0].name).toBe("test");
      expect(connected[0].count).toBe(1);

      agent.run("go");
      const result = await agent.until((s): Event | null => {
        const hit = s.events.find(
          (e) => e.type === "tool.result" && e.tool_call_id === "c1",
        );
        return hit ?? null;
      });
      expect(capturedTools).toContain("test__echo");
      const content = "content" in result ? result.content : "";
      expect(content).toBe("echoed: hello mcp");
    } finally {
      await agent.dispose();
    }
  }, 20_000);

  it("reports connection errors via onError without crashing the agent", async () => {
    const errors: Array<{ name: string; message: string }> = [];
    const infer: InferFn = async () => ({ content: "ok" });
    const agent = createAgentRuntime({
      infer,
      extensions: [
        mcpServers({
          servers: [{ name: "dead", transport: "http", url: "http://127.0.0.1:1/mcp" }],
          onError: (name, err) => errors.push({ name, message: err.message }),
        }),
      ],
    });
    try {
      agent.run("hi");
      await agent.until((s) =>
        s.events.some((e) => e.type === "assistant.message") ? true : null,
      );
      // Let onError finish firing.
      await agent.until(() => (errors.length > 0 ? true : null));
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].name).toBe("dead");
    } finally {
      await agent.dispose();
    }
  }, 10_000);
});
