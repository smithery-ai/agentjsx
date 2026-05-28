import { Effect, Layer, Schema } from "effect";
import { AgentCtx, defineTool, type Extension } from "@flamecast/agentjsx";
import type { SessionStore } from "../session-store";

// Mirrors Hermes's session_search_tool.py. Two modes in one tool:
//
//   - Browse mode (no query): returns metadata for the most recent
//     sessions — title, startedAt, message count. Cheap, no scan.
//   - Search mode: scores messages against query terms, returns the
//     top-N sessions ranked by hit count, each with an excerpt
//     centered on the first hit.
//
// Hermes additionally summarizes each match with an aux LLM (Gemini
// Flash). We surface raw excerpts instead — preserves the search →
// excerpt → load pattern without requiring a second model. Plug a
// summarizer in via `summarize` if you want the full Hermes shape.

export interface SessionSummarizer {
  readonly summarize: (
    session: { title: string; excerpt: string; transcript: string },
    query: string,
  ) => Promise<string>;
}

export interface SessionSearchOptions {
  readonly store: SessionStore;
  readonly toolName?: string;
  readonly summarizer?: SessionSummarizer;
}

const RoleSchema = Schema.Literal("user", "assistant", "tool");

const formatTranscript = (
  messages: ReadonlyArray<{
    role: string;
    content: string;
    toolName?: string;
  }>,
): string =>
  messages
    .map((m) => {
      const tag =
        m.role === "tool" && m.toolName
          ? `[TOOL:${m.toolName}]`
          : `[${m.role.toUpperCase()}]`;
      return `${tag}: ${m.content}`;
    })
    .join("\n\n");

export const sessionSearch = (opts: SessionSearchOptions): Extension => {
  const toolName = opts.toolName ?? "session_search";

  return Layer.scopedDiscard(
    Effect.gen(function* () {
      const ctx = yield* AgentCtx;

      yield* ctx.addTool(
        defineTool({
          name: toolName,
          description:
            "Search past sessions for relevant prior conversations. " +
            "Pass `query` (keywords or phrase) to search; omit `query` to " +
            "browse the most recent sessions. Returns up to `limit` matches " +
            "(default 3, max 5) with excerpts. Use this when the user " +
            "references something from before the current session.",
          parameters: Schema.Struct({
            query: Schema.optional(Schema.String),
            limit: Schema.optional(Schema.Number),
            roles: Schema.optional(Schema.Array(RoleSchema)),
          }),
          run: async ({ query, limit, roles }) => {
            const cap = Math.max(1, Math.min(limit ?? 3, 5));

            if (!query || query.trim().length === 0) {
              const recent = await opts.store.listRecent(cap);
              if (recent.length === 0) return "No past sessions on record.";
              return JSON.stringify(
                recent.map((s) => ({
                  id: s.id,
                  title: s.title,
                  startedAt: s.startedAt,
                  messageCount: s.messages.length,
                })),
                null,
                2,
              );
            }

            const matches = await opts.store.search(query, {
              limit: cap,
              roles,
            });
            if (matches.length === 0) {
              return `No matches for "${query}" in past sessions.`;
            }

            const results: Array<Record<string, unknown>> = [];
            for (const m of matches) {
              const base = {
                id: m.session.id,
                title: m.session.title,
                startedAt: m.session.startedAt,
                score: m.score,
                excerpt: m.excerpt,
              };
              if (opts.summarizer) {
                try {
                  const summary = await opts.summarizer.summarize(
                    {
                      title: m.session.title,
                      excerpt: m.excerpt,
                      transcript: formatTranscript(m.session.messages),
                    },
                    query,
                  );
                  results.push({ ...base, summary });
                  continue;
                } catch {
                  // fall through to excerpt-only
                }
              }
              results.push(base);
            }
            return JSON.stringify(results, null, 2);
          },
        }),
      ).pipe(
        Effect.catchTag("DuplicateToolError", (err) =>
          ctx.reportError("hermes/session-search", err),
        ),
      );
    }),
  );
};
