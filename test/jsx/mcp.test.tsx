// E2E test for <McpServer />. Uses the test-only cache-seed escape
// hatch in `src/jsx/components/mcp.tsx` to install a fake MCP client +
// tool listing before the first render. That exercises the cache-hit
// branch of the component (the same branch production hits on the
// second render after the live connect resolves) while keeping the
// test hermetic — no real `@modelcontextprotocol/sdk` round-trip.

import { Chunk, Effect, SubscriptionRef } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { AgentCtx, createAgentRuntime, render } from "@flamecast/agentjsx";
import {
  createElement,
  Agent,
  Block,
  McpServer,
  Messages,
} from "@flamecast/agentjsx/components";
import { __testing__ as mcpTesting } from "../../src/jsx/components/mcp";
import type {
  Event,
  InferFn,
  ProviderContext,
} from "@flamecast/agentjsx";

void createElement;

const systemString = (ctx: ProviderContext): string => {
  if (typeof ctx.system === "string") return ctx.system;
  return ctx.system.map((c) => c.text).join("");
};

describe("jsx McpServer e2e", () => {
  afterEach(() => {
    mcpTesting.reset();
  });

  it("registers namespaced MCP tools from a pre-seeded cache and routes calls through the fake client", async () => {
    const callToolCalls: Array<{
      name: string;
      arguments: Record<string, unknown>;
    }> = [];
    mcpTesting.seed(
      "test",
      "https://fake/",
      [
        {
          name: "search",
          description: "Search the test corpus",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      ],
      async (args) => {
        callToolCalls.push(args);
        return {
          content: [
            { type: "text", text: `canned:${String(args.arguments.query)}` },
          ],
        };
      },
    );

    const seenContexts: ProviderContext[] = [];
    let turn = 0;
    const infer: InferFn = async (context) => {
      seenContexts.push(context);
      turn++;
      if (turn === 1) {
        return {
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "test_search",
                arguments: JSON.stringify({ query: "hello" }),
              },
            },
          ],
        };
      }
      return { content: "Saw the search result.", tool_calls: [] };
    };

    const agent = createAgentRuntime({
      infer,
      context: () =>
        render(
          <Agent>
            <Block name="role">test</Block>
            <McpServer name="test" url="https://fake/" />
            <Messages />
          </Agent>,
        ),
    });

    try {
      await agent.send("go");

      await agent.until<Event>((snap) => {
        for (let i = snap.events.length - 1; i >= 0; i--) {
          const e = snap.events[i]!;
          if (
            e.type === "assistant.message" &&
            e.content === "Saw the search result."
          ) {
            return e;
          }
        }
        return null;
      });

      // Assertion 1: namespaced tool is in the live ctx.tools snapshot.
      const liveToolNames = await agent.runtime.runPromise(
        Effect.gen(function* () {
          const ctx = yield* AgentCtx;
          const tools = yield* SubscriptionRef.get(ctx.tools);
          return Chunk.toReadonlyArray(tools).map((t) => t.name);
        }),
      );
      expect(liveToolNames).toContain("test_search");

      // Assertion 2: first ProviderContext that infer saw declares the
      // namespaced tool.
      const firstCtx = seenContexts[0]!;
      expect(firstCtx).toBeDefined();
      const declaredTurn1 = firstCtx.tools.map((t) => t.name);
      expect(declaredTurn1).toContain("test_search");

      // Assertion 3: the tool's run() actually called through to the
      // seeded fake client, and the tool.result content reflects the
      // canned response.
      const events = await agent.events();
      const toolResult = events.find(
        (e) => e.type === "tool.result" && e.tool_call_id === "call_1",
      ) as Extract<Event, { type: "tool.result" }> | undefined;
      expect(toolResult).toBeDefined();
      expect(toolResult!.content).toBe("canned:hello");
      expect(callToolCalls.length).toBe(1);
      expect(callToolCalls[0]).toEqual({
        name: "search",
        arguments: { query: "hello" },
      });

      // Assertion 4: the rendered system text contains the <mcp> block
      // listing the namespaced tool.
      const sys1 = systemString(firstCtx);
      expect(sys1).toContain('<mcp name="test">');
      expect(sys1).toContain("test_search");

      // Assertion 5: exactly two infer turns happened.
      expect(turn).toBe(2);
      expect(seenContexts.length).toBe(2);
    } finally {
      await agent.dispose();
    }
  });
});
