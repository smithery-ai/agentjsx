import { Effect, Layer, Schema } from "effect";
import { AgentCtx } from "../core/agent-ctx";
import type { Extension } from "../core/agent";
import { registerTool } from "./tool-registration";

export interface WebSearchOptions {
  // Exa API key. Required — the extension shows `web_search` in the
  // tool surface but the tool returns a clear error if the key is
  // empty so the LLM sees the failure instead of getting silent nulls.
  apiKey: string;
  // Max results returned when the LLM doesn't pass `numResults`. Default 5.
  defaultNumResults?: number;
  // Characters of text snippet to include per result. Default 400.
  snippetChars?: number;
}

interface ExaResult {
  title: string;
  url: string;
  text?: string;
  publishedDate?: string;
}

interface ExaResponse {
  results?: ExaResult[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const isExaResult = (v: unknown): v is ExaResult =>
  isRecord(v) && typeof v.title === "string" && typeof v.url === "string";

// Web search via Exa. One tool: `web_search(query, numResults?)`.
// Backend-agnostic beyond `fetch` — works in Node, Cloudflare Workers,
// Deno, browsers.
//
// Security: Exa searches are sent with the provided `apiKey`. Keep the
// key out of event logs and tool.result content; this extension does
// not persist or echo it.
export const webSearch = (opts: WebSearchOptions): Extension => {
  const { apiKey, defaultNumResults = 5, snippetChars = 400 } = opts;

  return Layer.scopedDiscard(
    Effect.gen(function* () {
      const ctx = yield* AgentCtx;

      yield* registerTool(ctx, "web-search", {
        name: "web_search",
        description:
          "Search the web via Exa. Returns an array of {title, url, snippet} for the top matches. Use this for any question that requires current or world-knowledge information the model wasn't trained on.",
        parameters: Schema.Struct({
          query: Schema.String.annotations({
            description: "Natural language query. Be specific.",
          }),
          numResults: Schema.Number.annotations({
            description: `Maximum results to return. Default ${defaultNumResults}.`,
          }).pipe(Schema.optionalWith({ nullable: true })),
        }),
        run: async (args) => {
            if (!apiKey) return "Error: EXA_API_KEY is not set on the harness host.";
            const query = args.query.trim();
            if (!query) return "Error: query is required.";
            const n =
              args.numResults !== undefined
                ? Math.max(1, Math.min(20, Math.floor(args.numResults)))
                : defaultNumResults;

            const res = await fetch("https://api.exa.ai/search", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
              },
              body: JSON.stringify({
                query,
                numResults: n,
                type: "auto",
                contents: { text: { maxCharacters: snippetChars } },
              }),
            });
            if (!res.ok) {
              const text = await res.text();
              return `Error: Exa ${res.status}: ${text.slice(0, 500)}`;
            }
            const raw: unknown = await res.json();
            const parsed: ExaResponse = isRecord(raw) && Array.isArray(raw.results)
              ? { results: raw.results.filter(isExaResult) }
              : {};
            const results = (parsed.results ?? []).map((r) => ({
              title: r.title,
              url: r.url,
              publishedDate: r.publishedDate,
              snippet:
                typeof r.text === "string"
                  ? r.text.replace(/\s+/g, " ").slice(0, snippetChars)
                  : "",
            }));
            if (results.length === 0) {
              return `No results for "${query}".`;
            }
            return JSON.stringify(results, null, 2);
          },
      });
    }),
  );
};
