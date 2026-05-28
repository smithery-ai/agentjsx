import { Chunk } from "effect";
import type { Fragment, Event, ToolCall } from "./types";

// Pure projections over the event log. Mirrors the semantics in
// `signals/graph.ts` but parameterized over `Chunk<Event>` instead of
// `Event[]`. All functions are referentially transparent and contain no
// Effect machinery — they are composed inside stream pipelines.

// User-message content can be any shape the agent's `inputSchema`
// validates to (string by default, otherwise structured). LLM blocks
// always carry string content, so non-string values are serialized.
function userContentToString(content: unknown): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

// Per-variant projector type. Each entry in the dispatch table receives
// its narrowed event variant and returns a block (or `null` for events
// that are internal bookkeeping / handled separately by range collapse).
type Projector<K extends Event["type"]> = (
  event: Extract<Event, { type: K }>,
) => Fragment | null;

// Dispatch table keyed by `Event["type"]`. The mapped-object type makes
// exhaustiveness a compile-time property: adding a new variant to `Event`
// in `types.ts` without a corresponding entry here is a TS error, no
// manual `never` guard required.
type ProjectorTable = {
  readonly [K in Event["type"]]: Projector<K>;
};

// Per-event-type metadata flags. Kept as a mapped-object type keyed by
// `Event["type"]` for the same exhaustiveness guarantee as PROJECTORS —
// adding a new variant to `Event` in `types.ts` without an EVENT_META
// entry is a TS error.
//
// Consumers (e.g. `recall`) read these flags instead of hardcoding
// event-type string checks. Centralizing the classification keeps the
// "is this event internal bookkeeping" question in one place, adjacent
// to the projection rules themselves.
export interface EventMeta {
  // True if the event projects to a Fragment in the normal history stream.
  // False for intent beacons and projection-metadata events.
  readonly projectable: boolean;
  // True if `recall` should hide this event from its listing output.
  // Conversational events (user/assistant/tool) are visible; internal
  // bookkeeping is not.
  readonly hiddenByRecall: boolean;
  // True if the event participates in projection semantics beyond its
  // own row (e.g. `compaction.summary` drives the range-collapse pass).
  // Pure documentation today — future consumers (hydration diagnostics,
  // log inspectors) can use this to render markers differently.
  readonly structural: boolean;
}

export const EVENT_META: { readonly [K in Event["type"]]: EventMeta } = {
  "user.message":       { projectable: true,  hiddenByRecall: false, structural: false },
  "assistant.message":  { projectable: true,  hiddenByRecall: false, structural: false },
  "tool.call.started":  { projectable: false, hiddenByRecall: true,  structural: false },
  "tool.result":        { projectable: true,  hiddenByRecall: false, structural: false },
  "assistant.halted":   { projectable: true,  hiddenByRecall: false, structural: false },
  "inference.failed":   { projectable: true,  hiddenByRecall: false, structural: false },
  "compaction.summary": { projectable: false, hiddenByRecall: true,  structural: true  },
  "todo.added":         { projectable: false, hiddenByRecall: true,  structural: true  },
  "todo.completed":     { projectable: false, hiddenByRecall: true,  structural: true  },
};

const PROJECTORS: ProjectorTable = {
  "user.message": (e) => ({
    tag: "core/user-message",
    content: userContentToString(e.content),
    eventSeq: e.seq,
    source: "history",
  }),
  "assistant.message": (e) => {
    const f: Fragment = {
      tag: "core/assistant-message",
      content: e.content,
      eventSeq: e.seq,
      source: "history",
    };
    if (e.tool_calls) f.toolCalls = e.tool_calls;
    return f;
  },
  "tool.result": (e) => ({
    tag: "core/tool-result",
    toolCallId: e.tool_call_id,
    content: e.content,
    eventSeq: e.seq,
    source: "history",
  }),
  "assistant.halted": (e) => ({
    tag: "core/assistant-message",
    content: `[stopped: ${e.reason}]`,
    eventSeq: e.seq,
    source: "history",
  }),
  // Surfaced into the LLM-facing block stream so a follow-up turn (if
  // the user re-sends) can see why the previous one died. Renders as a
  // bracketed assistant message; consumers writing custom projections
  // can switch on `tag` if they want a different shape.
  "inference.failed": (e) => ({
    tag: "core/assistant-message",
    content: `[inference failed: ${e.cause}]`,
    eventSeq: e.seq,
    source: "history",
  }),
  // Internal intent beacon for crash recovery; not projected to the LLM.
  "tool.call.started": () => null,
  // Compaction events are metadata for the projection, not blocks on
  // their own. The boundary block is emitted inline at the first covered
  // seq (see renderHistoryFragments) so it appears where the compacted
  // range USED to be, not where the compaction marker was appended later.
  "compaction.summary": () => null,
  // Todo state mutations are internal — the `<Todo>` block reduces over
  // them at render time to derive its ambient content. They never
  // surface as messages in the history stream.
  "todo.added": () => null,
  "todo.completed": () => null,
};

// Project a single event to its LLM-facing fragment, or `null` for events
// that are internal bookkeeping (intent beacons). Kept private so the
// only public entry into projection is `renderHistoryFragments`, which
// guarantees the `null` filter is applied consistently.
export function eventToFragment(e: Event): Fragment | null {
  // Generic-boundary cast: TS structurally can't narrow
  // `PROJECTORS[e.type]` to `Projector<typeof e.type>` because the
  // indexed-access distributes over the full union, collapsing to the
  // intersection of parameter types (i.e. `never`). Each table entry is
  // typed correctly on its own; this cast re-ties the key to the value
  // at the dispatch site. Only permitted per CLAUDE.md's generic-boundary
  // rule.
  // oxlint-disable-next-line no-type-assertion -- generic boundary: mapped-table indexed access collapses param type to never; per-key types are sound.
  return (PROJECTORS[e.type] as Projector<typeof e.type>)(e);
}

interface BoundaryMeta {
  fromSeq: number;
  toSeq: number;
  text: string;
  prompt?: string;
}

export function renderHistoryFragments(events: Chunk.Chunk<Event>): Fragment[] {
  const arr = Chunk.toReadonlyArray(events);

  const boundaries: BoundaryMeta[] = [];
  for (const e of arr) {
    if (e.type === "compaction.summary") {
      boundaries.push(
        e.prompt !== undefined
          ? { fromSeq: e.fromSeq, toSeq: e.toSeq, text: e.text, prompt: e.prompt }
          : { fromSeq: e.fromSeq, toSeq: e.toSeq, text: e.text },
      );
    }
  }
  if (boundaries.length === 0) {
    const out: Fragment[] = [];
    for (const e of arr) {
      const fragment = eventToFragment(e);
      if (fragment !== null) out.push(fragment);
    }
    return out;
  }

  const covered = new Set<number>();
  for (const b of boundaries) {
    for (let s = b.fromSeq; s <= b.toSeq; s++) covered.add(s);
  }

  const emitted = new Set<BoundaryMeta>();
  const out: Fragment[] = [];
  for (const e of arr) {
    if (covered.has(e.seq)) {
      // First unemitted boundary covering this seq. `boundaries` is in
      // log order, so each boundary emits exactly once — at the
      // earliest seq in its range that hasn't already been claimed by
      // an earlier boundary. Disjoint ranges produce one fragment per
      // boundary in stable order. Overlapping ranges still emit every
      // boundary (each at its own unclaimed position); they don't
      // collapse into one.
      let match: BoundaryMeta | undefined;
      for (const b of boundaries) {
        if (b.fromSeq <= e.seq && e.seq <= b.toSeq && !emitted.has(b)) {
          match = b;
          break;
        }
      }
      if (match) {
        emitted.add(match);
        const coveredCount = match.toSeq - match.fromSeq + 1;
        out.push({
          tag: "core/compaction-summary",
          content: `[compacted ${coveredCount} prior turns]\n\n${match.text}`,
          covered: [match.fromSeq, match.toSeq] as const,
          source: "compaction",
        });
      }
      continue;
    }
    const fragment = eventToFragment(e);
    if (fragment !== null) out.push(fragment);
  }
  return out;
}

// Find the most recent `assistant.message` with tool_calls; return those
// calls whose ids have no matching `tool.result`. Iterating from the end
// and skipping non-assistant events is load-bearing: reading `.at(-1)`
// would drop the batch whenever a non-assistant event (e.g. a racing
// `assistant.halted`) lands after it, silently preventing dispatch of
// non-idempotent tools. See signals/graph.ts:211-232.
export function pendingToolCallsFromLog(events: Chunk.Chunk<Event>): ToolCall[] {
  const arr = Chunk.toReadonlyArray(events);
  const resulted = new Set<string>();
  for (const e of arr) {
    if (e.type === "tool.result") resulted.add(e.tool_call_id);
  }
  for (let i = arr.length - 1; i >= 0; i--) {
    const e = arr[i];
    if (e.type !== "assistant.message") continue;
    if (!e.tool_calls || e.tool_calls.length === 0) return [];
    return e.tool_calls.filter((tc) => !resulted.has(tc.id));
  }
  return [];
}

// "Last result" = terminal assistant.message whose tool_calls are all
// resolved (or absent). Used by the `result` accessor and `until`
// predicates that wait for a final answer.
export function lastResult(events: Chunk.Chunk<Event>): Event | null {
  const last = Chunk.last(events);
  if (last._tag === "None") return null;
  const ev = last.value;
  if (ev.type !== "assistant.message") return null;
  return !ev.tool_calls || ev.tool_calls.length === 0 ? ev : null;
}

export function toolsInFlight(events: Chunk.Chunk<Event>): boolean {
  const resulted = new Set<string>();
  for (const e of events) {
    if (e.type === "tool.result") resulted.add(e.tool_call_id);
  }
  for (const e of events) {
    if (e.type === "tool.call.started" && !resulted.has(e.tool_call_id)) return true;
  }
  return false;
}

// Halt is absorbing WITHIN a turn but NOT across turns: a new
// `user.message` after a halt resumes the agent. Scanning from the end,
// the first terminal marker we hit wins — a `user.message` resets,
// an `assistant.halted` halts. This matches interactive REPL
// expectations (maxSteps cap a task's tool-use depth, not the session's
// lifetime) while preserving the within-turn invariants: no new
// inference fires after halt until the user explicitly asks the agent
// to continue by sending another message.
export function isHalted(events: Chunk.Chunk<Event>): boolean {
  const arr = Chunk.toReadonlyArray(events);
  for (let i = arr.length - 1; i >= 0; i--) {
    const e = arr[i];
    if (e.type === "user.message") return false;
    if (e.type === "assistant.halted") return true;
    // `inference.failed` is also terminal within a turn — the
    // inference loop rejected (and we appended this); no further
    // assistant work happens until the user re-sends.
    if (e.type === "inference.failed") return true;
  }
  return false;
}
