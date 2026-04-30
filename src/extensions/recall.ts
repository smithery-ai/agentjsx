import { Chunk, Effect, Layer, Schema } from "effect";
import { AgentCtx } from "../agent-ctx";
import type { Extension } from "../agent";
import { EVENT_META } from "../projections";
import type { Event } from "../types";
import { registerTool } from "./tool-registration";

export interface RecallOptions {
  // Tool name surfaced to the model. Default "recall" — matches the
  // extension name and reads naturally at the LLM call site
  // (`recall({ seqs: [42] })`).
  readonly toolName?: string;
  // Max events returned per call for range / type / match queries.
  // Exact-seqs lookups (passing `seqs: [...]`) are NOT bounded by this —
  // the caller asked for specific rows, so we honor them up to
  // `maxEventsPerCall` seqs in the request array.
  readonly maxEventsPerCall?: number;
  // Soft char budget per call for range / type / match queries. When
  // the accumulated formatted output exceeds this, the tool truncates
  // the list and tells the model to narrow.
  readonly maxCharsPerCall?: number;
  // Char cap PER EVENT for exact-seqs lookups. Lets recovery of a
  // single big tool.result succeed where bulk listings would hit the
  // aggregate cap. Default 50k matches Claude Code's persistence
  // threshold — big enough to recover most real outputs.
  readonly singleSeqMaxChars?: number;
  // When true, events flagged `hiddenByRecall` in EVENT_META (see
  // `../projections.ts`) are hidden from results — currently intent
  // beacons and projection-metadata events. Default true — these are
  // rarely meaningful to the model. The event-type classification lives
  // in EVENT_META so this extension doesn't hardcode the list.
  readonly hideInternal?: boolean;
}

// Exposes the event log as addressable memory. Registers one tool —
// `recall` by default — that the model can call to recall previously
// observed events by seq, type, range, or content match. Works without
// filesystem or external store because the log itself IS the store.
//
// Use cases: recover a truncated tool output, re-read the user's earlier
// ask, audit prior tool calls, replay reasoning. Pairs well with
// `truncateToolOutputs` — that extension's truncation message embeds a
// `recall({ seqs: [N] })` pointer so the model can always recover the
// full content on demand.
export const recall = (opts: RecallOptions = {}): Extension => {
  const toolName = opts.toolName ?? "recall";
  const maxEventsPerCall = opts.maxEventsPerCall ?? 20;
  const maxCharsPerCall = opts.maxCharsPerCall ?? 10_000;
  const singleSeqMaxChars = opts.singleSeqMaxChars ?? 50_000;
  const hideInternal = opts.hideInternal ?? true;

  return Layer.scopedDiscard(
    Effect.gen(function* () {
      const ctx = yield* AgentCtx;

      yield* registerTool(ctx, "recall", {
        name: toolName,
        description:
          "Read the raw event log — your long-term memory. Use this to recover a tool output that got truncated, re-read the user's earlier ask, or audit prior tool calls. Provide either `seqs` (specific event IDs) or filter by `type` / `fromSeq` / `toSeq` / `match`. Exact-seq lookups return up to 50k chars per event; filtered listings return up to 20 events or 10k chars, whichever comes first.",
        parameters: Schema.Struct({
          seqs: Schema.Array(Schema.Number).annotations({
            description:
              "Specific event seq numbers to fetch. Overrides all other filters. Prefer this for targeted recovery of a single event.",
          }).pipe(Schema.optionalWith({ nullable: true })),
          type: Schema.String.annotations({
            description:
              "Filter by event type. One of: user.message, assistant.message, tool.result, assistant.halted.",
          }).pipe(Schema.optionalWith({ nullable: true })),
          fromSeq: Schema.Number.annotations({
            description: "Inclusive lower bound on seq.",
          }).pipe(Schema.optionalWith({ nullable: true })),
          toSeq: Schema.Number.annotations({
            description: "Inclusive upper bound on seq.",
          }).pipe(Schema.optionalWith({ nullable: true })),
          match: Schema.String.annotations({
            description:
              "Substring match on event content (case-sensitive). Applied after type/range filters.",
          }).pipe(Schema.optionalWith({ nullable: true })),
          limit: Schema.Number.annotations({
            description: `Max events to return for filtered listings. Default ${maxEventsPerCall}.`,
          }).pipe(Schema.optionalWith({ nullable: true })),
        }),
        run: async (args) => {
          const events = await Effect.runPromise(ctx.events.snapshot);
          const arr = Chunk.toReadonlyArray(events);

          const filterInternal = (e: Event): boolean =>
            !hideInternal || !EVENT_META[e.type].hiddenByRecall;

          if (args.seqs && args.seqs.length > 0) {
            const wanted = args.seqs.slice(0, maxEventsPerCall);
            const picked: Event[] = [];
            for (const seq of wanted) {
              const e = arr.find((ev) => ev.seq === seq);
              if (e && filterInternal(e)) picked.push(e);
            }
            if (picked.length === 0) {
              return `No events found for seqs=${JSON.stringify(wanted)}.`;
            }
            // Exact-seq path: per-event cap is generous (50k) so a
            // single big tool.result can come back. But when multiple
            // seqs are requested, the whole response still needs to
            // fit — apply the filtered-listing aggregate cap on top so
            // `recall({ seqs: [0..19] })` can't flood the context.
            const aggregate =
              picked.length > 1 ? maxCharsPerCall : undefined;
            return formatEvents(picked, arr, singleSeqMaxChars, aggregate);
          }

          const limit = Math.min(args.limit ?? maxEventsPerCall, maxEventsPerCall);
          const candidates = arr.filter((e) => {
            if (!filterInternal(e)) return false;
            if (args.type && e.type !== args.type) return false;
            if (args.fromSeq !== undefined && e.seq < args.fromSeq) return false;
            if (args.toSeq !== undefined && e.seq > args.toSeq) return false;
            if (args.match && !eventContent(e).includes(args.match)) return false;
            return true;
          });
          if (candidates.length === 0) {
            return "No events matched the filters.";
          }
          const picked = candidates.slice(-limit); // most recent `limit` matches
          const output = formatEvents(picked, arr, undefined, maxCharsPerCall);
          const truncatedNote =
            candidates.length > picked.length
              ? `\n\n[${candidates.length - picked.length} earlier matches omitted — narrow with fromSeq/toSeq/match]`
              : "";
          return output + truncatedNote;
        },
      });
    }),
  );
};

// Format a listing of events for the model. Each event gets a header
// line with seq + type + turn number, then its content. Applies a
// per-event char cap (exact-seq mode) or a whole-response char cap
// (filtered listing mode) — at most one of the two is set.
const formatEvents = (
  picked: ReadonlyArray<Event>,
  allEvents: ReadonlyArray<Event>,
  perEventCap: number | undefined,
  totalCap: number | undefined,
): string => {
  const out: string[] = [];
  let total = 0;
  let truncated = false;
  for (const e of picked) {
    const header = formatHeader(e, allEvents);
    const body = applyCap(eventContent(e), perEventCap);
    const block = `${header}\n${body}`;
    if (totalCap !== undefined && total + block.length > totalCap) {
      out.push(
        `[... aggregate char cap ${totalCap} reached, ${picked.length - out.length} events omitted]`,
      );
      truncated = true;
      break;
    }
    out.push(block);
    total += block.length;
  }
  void truncated;
  return out.join("\n\n");
};

const applyCap = (content: string, cap: number | undefined): string => {
  if (cap === undefined || content.length <= cap) return content;
  const head = content.slice(0, cap);
  const lastNewline = head.lastIndexOf("\n");
  const cut = lastNewline > cap * 0.5 ? head.slice(0, lastNewline) : head;
  return `${cut}\n[... content truncated at ${cap} chars of ${content.length}]`;
};

// Infer a turn number: count of user.message events with seq <= e.seq.
// Cheap, gives the model orientation without requiring wall-clock time.
const formatHeader = (e: Event, allEvents: ReadonlyArray<Event>): string => {
  let turn = 0;
  for (const ev of allEvents) {
    if (ev.seq > e.seq) break;
    if (ev.type === "user.message") turn++;
  }
  const extra =
    e.type === "tool.result" && "tool_call_id" in e
      ? `, tool_call_id=${e.tool_call_id}`
      : "";
  return `[seq ${e.seq}, ${e.type}, turn ${turn}${extra}]`;
};

// Extract the text content of an event for listing / matching. Events
// without text (tool.call.started if somehow requested) return an
// empty string. user.message content can be structured (per the
// agent's inputSchema); serialize non-string values for display.
const eventContent = (e: Event): string => {
  switch (e.type) {
    case "user.message":
      if (typeof e.content === "string") return e.content;
      try {
        return JSON.stringify(e.content, null, 2);
      } catch {
        return String(e.content);
      }
    case "assistant.message":
      return e.content;
    case "tool.result":
      return e.content;
    case "assistant.halted":
      return `[halted: ${e.reason}]`;
    case "inference.failed":
      return `[inference failed: ${e.cause}]`;
    case "compaction.summary":
      return e.text;
    case "tool.call.started":
      return "";
  }
};
