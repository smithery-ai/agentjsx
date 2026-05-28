import { afterEach, describe, expect, it } from "vitest";
import { createAgentRuntime, webSearch } from "@flamecast/agentjsx";
import type { Event } from "@flamecast/agentjsx";
import { scriptedInfer, toolCall } from "../helpers/scripted-infer";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const waitForResult = async (
  agent: ReturnType<typeof createAgentRuntime>,
  id: string,
): Promise<Event> => {
  return agent.until((s) => {
    const hit = s.events.find((e) => e.type === "tool.result" && e.tool_call_id === id);
    return hit ?? null;
  });
};

describe("agentctx: webSearch extension", () => {
  it("registers web_search and POSTs to Exa with query + apiKey header", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(
        JSON.stringify({
          results: [
            {
              title: "Example",
              url: "https://example.com",
              text: "A snippet about the topic.",
              publishedDate: "2026-04-10",
            },
          ],
        }),
        { status: 200 },
      );
    };
    globalThis.fetch = fetchImpl;

    const agent = createAgentRuntime({
      infer: scriptedInfer([
        {
          content: "",
          tool_calls: [
            toolCall("c1", "web_search", { query: "quantum computing", numResults: 3 }),
          ],
        },
        { content: "done" },
      ]),
      extensions: [webSearch({ apiKey: "test-key" })],
    });
    try {
      agent.send("search");
      const result = await waitForResult(agent, "c1");
      expect(calls).toHaveLength(1);
      const { url, init } = calls[0];
      expect(url).toBe("https://api.exa.ai/search");
      const headers = new Headers(init.headers);
      expect(headers.get("x-api-key")).toBe("test-key");
      const body: { query: string; numResults: number } = JSON.parse(String(init.body));
      expect(body.query).toBe("quantum computing");
      expect(body.numResults).toBe(3);
      const content = result?.type === "tool.result" ? result.content : "";
      const parsed: Array<{ url: string; snippet: string }> = JSON.parse(content);
      expect(parsed[0].url).toBe("https://example.com");
      expect(parsed[0].snippet).toContain("snippet about the topic");
    } finally {
      await agent.dispose();
    }
  });

  it("returns a clear error string when apiKey is empty", async () => {
    const agent = createAgentRuntime({
      infer: scriptedInfer([
        { content: "", tool_calls: [toolCall("c1", "web_search", { query: "test" })] },
        { content: "noted" },
      ]),
      extensions: [webSearch({ apiKey: "" })],
    });
    try {
      agent.send("go");
      const result = await waitForResult(agent, "c1");
      const content = "content" in result ? result.content : "";
      expect(content).toMatch(/EXA_API_KEY is not set/);
    } finally {
      await agent.dispose();
    }
  });

  it("surfaces Exa HTTP errors as tool.result content", async () => {
    const fetch400: typeof fetch = async () => new Response("bad request", { status: 400 });
    globalThis.fetch = fetch400;
    const agent = createAgentRuntime({
      infer: scriptedInfer([
        { content: "", tool_calls: [toolCall("c1", "web_search", { query: "x" })] },
        { content: "noted" },
      ]),
      extensions: [webSearch({ apiKey: "k" })],
    });
    try {
      agent.send("go");
      const result = await waitForResult(agent, "c1");
      const content = "content" in result ? result.content : "";
      expect(content).toMatch(/Exa 400/);
    } finally {
      await agent.dispose();
    }
  });
});
