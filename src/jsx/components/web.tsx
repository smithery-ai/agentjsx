// Capability components for the public web. Two tools, no platform
// dependency beyond a global `fetch` — works in Node 18+, Bun, browsers,
// Cloudflare Workers.
//
// Kept separate from the projection-time `web-search` extension at
// `src/extensions/web-search.ts`. The extension lives at the runtime
// layer and runs whether or not a JSX tree mounts it; these components
// live at render time and only contribute tools when the JSX tree
// includes them. Same Exa API call shape; deliberate duplication to
// keep the JSX path free of Effect/Layer plumbing.

import { Schema } from "effect";
import { defineTool } from "../../core/define-tool";
import type { Fragment as RenderedFragment } from "../../core/types";
import { emitFragment, emitTool, type Element, type Node } from "../runtime";

// ---------------------------------------------------------------------
// <WebSearch apiKey="..." />
//
// Exposes `web_search(query, numResults?)`. Backed by Exa.
// ---------------------------------------------------------------------

export interface WebSearchProps {
  readonly apiKey: string;
  readonly defaultNumResults?: number;
  readonly snippetChars?: number;
}

interface ExaResult {
  title: string;
  url: string;
  text?: string;
  publishedDate?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const isExaResult = (v: unknown): v is ExaResult =>
  isRecord(v) && typeof v.title === "string" && typeof v.url === "string";

export function WebSearch(props: WebSearchProps): Node {
  const { apiKey, defaultNumResults = 5, snippetChars = 400 } = props;

  const web_search = defineTool({
    name: "web_search",
    description:
      "Search the web via Exa. Returns top matches as {title, url, snippet}. Use for current or world-knowledge information the model wasn't trained on.",
    parameters: Schema.Struct({
      query: Schema.String.annotations({
        description: "Natural language query. Be specific.",
      }),
      numResults: Schema.Number.annotations({
        description: `Maximum results. Default ${defaultNumResults}.`,
      }).pipe(Schema.optionalWith({ nullable: true })),
    }),
    run: async ({ query, numResults }) => {
      if (!apiKey) return "Error: WebSearch apiKey is empty.";
      const q = query.trim();
      if (!q) return "Error: query is required.";
      const n =
        numResults !== undefined
          ? Math.max(1, Math.min(20, Math.floor(numResults)))
          : defaultNumResults;

      try {
        const res = await fetch("https://api.exa.ai/search", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
          },
          body: JSON.stringify({
            query: q,
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
        const results =
          isRecord(raw) && Array.isArray(raw.results)
            ? raw.results.filter(isExaResult).map((r) => ({
                title: r.title,
                url: r.url,
                publishedDate: r.publishedDate,
                snippet:
                  typeof r.text === "string"
                    ? r.text.replace(/\s+/g, " ").slice(0, snippetChars)
                    : "",
              }))
            : [];
        if (results.length === 0) return `No results for "${q}".`;
        return JSON.stringify(results, null, 2);
      } catch (e) {
        return `[web_search] Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  const block: RenderedFragment = {
    tag: "core/system",
    content: "<web_search>(call `web_search` to query Exa)</web_search>",
    source: "web-search",
  };

  const emits: Element[] = [emitTool(web_search), emitFragment(block)];
  return emits as Node;
}

// ---------------------------------------------------------------------
// <WebFetch maxChars={20000} />
//
// Exposes `web_fetch(url)`. GETs a URL and returns the body, truncated
// to `maxChars`. No HTML stripping — the model is trusted to read raw
// markup; a "readability" mode is a follow-up.
// ---------------------------------------------------------------------

export interface WebFetchProps {
  // Max characters of body returned. Default 20000. Longer responses are
  // sliced; a `[truncated]` suffix is appended.
  readonly maxChars?: number;
  // Optional fixed headers for every request (e.g. `User-Agent`).
  readonly headers?: Record<string, string>;
}

export function WebFetch(props: WebFetchProps = {}): Node {
  const { maxChars = 20000, headers } = props;

  const web_fetch = defineTool({
    name: "web_fetch",
    description:
      "GET a URL and return the response body as text. Body is truncated past a character budget. Use for fetching docs, READMEs, or specific pages you already have a URL for.",
    parameters: Schema.Struct({
      url: Schema.String.annotations({
        description: "Absolute http(s) URL to fetch.",
      }),
    }),
    run: async ({ url }) => {
      const target = url.trim();
      if (!/^https?:\/\//i.test(target)) {
        return `Error: web_fetch only accepts http(s) URLs; got "${target}".`;
      }
      try {
        const res = await fetch(target, { headers });
        const contentType = res.headers.get("content-type") ?? "";
        const text = await res.text();
        const sliced =
          text.length > maxChars
            ? `${text.slice(0, maxChars)}\n[truncated: ${text.length} chars total]`
            : text;
        const status = `${res.status} ${res.statusText}`.trim();
        return `[${status}] ${contentType}\n\n${sliced}`;
      } catch (e) {
        return `[web_fetch] Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  const block: RenderedFragment = {
    tag: "core/system",
    content: "<web_fetch>(call `web_fetch` with an http(s) URL)</web_fetch>",
    source: "web-fetch",
  };

  const emits: Element[] = [emitTool(web_fetch), emitFragment(block)];
  return emits as Node;
}
