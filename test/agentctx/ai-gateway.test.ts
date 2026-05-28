import { afterEach, describe, expect, it, vi } from "vitest";
import { createAiGatewayInfer } from "@flamecast/agentctx/providers";

const API_KEY = "vercel-gateway-key";

afterEach(() => {
  vi.restoreAllMocks();
});

// Minimal V3 language-model response shape that the AI SDK's gateway
// provider expects to receive from the Vercel AI Gateway upstream.
function mockGatewayResponseBody(text: string) {
  return {
    content: [{ type: "text", text }],
    usage: {
      inputTokens: { total: 5 },
      outputTokens: { total: 7 },
    },
    finishReason: "stop",
    warnings: [],
  };
}

describe("createAiGatewayInfer", () => {
  it("forwards providerOptions to the AI Gateway request body", async () => {
    const fetchSpy = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify(mockGatewayResponseBody("hello")), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const infer = createAiGatewayInfer({
      apiKey: API_KEY,
      model: "google/gemini-2.5-flash-lite",
      fetch: fetchSpy,
      providerOptions: {
        gateway: {
          only: ["google"],
        },
      },
    });

    const result = await infer({
      system: "Reply in exactly one word.",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    });

    expect(fetchSpy).toHaveBeenCalled();
    const call = fetchSpy.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call!;
    expect(String(url)).toMatch(/^https:\/\/ai-gateway\.vercel\.sh\//);
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(headers.get("ai-language-model-id")).toBe("google/gemini-2.5-flash-lite");
    const body: { providerOptions?: { gateway?: { only?: string[] } } } = JSON.parse(
      String(init?.body),
    );
    expect(body.providerOptions?.gateway?.only).toEqual(["google"]);
    expect(result.content).toBe("hello");
  });

  // Pins the integration surface that lets cloud-claude-style
  // callers capture provider metadata (e.g. Vercel's
  // `providerMetadata.gateway.generationId` for deferred cost
  // resolution) without vendoring the entire provider.
  it("invokes onResponse after each generateText with the raw result", async () => {
    const fetchSpy = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify(mockGatewayResponseBody("ok")), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const seen: Array<{ text: string | undefined }> = [];
    const infer = createAiGatewayInfer({
      apiKey: API_KEY,
      model: "anthropic/claude-haiku-4-5",
      fetch: fetchSpy,
      onResponse: (res) => {
        seen.push({ text: res.text });
      },
    });
    await infer({
      system: "",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.text).toBe("ok");
  });
});
