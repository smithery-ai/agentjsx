import { Chunk } from "effect";
import type { Event } from "./types";

// End seq of the most recent `compaction.summary` event, or -1 when
// none exist. Used by compaction drivers to compute the next `fromSeq`
// so stacked boundaries cover disjoint ranges.
export const lastCompactionEnd = (events: Chunk.Chunk<Event>): number => {
  const arr = Chunk.toReadonlyArray(events);
  for (let i = arr.length - 1; i >= 0; i--) {
    const e = arr[i];
    if (e.type === "compaction.summary") return e.toSeq;
  }
  return -1;
};

// A tool-call group is one `assistant.message` carrying `tool_calls`
// plus its matching `tool.result` events. Splitting a group — placing a
// compaction boundary between the assistant call and one of its results
// — orphans the tail-side `tool.result` blocks: the projection
// collapses the assistant message into a `compaction.summary` system
// block, leaving `role: "tool"` blocks in the tail with no visible
// `tool_use_id`. Anthropic / OpenAI reject such payloads
// ("tool_result without matching tool_use").
//
// `end` is the largest result seq in a group, or +Infinity if any call
// is still unresolved (no matching `tool.result` yet). `[assistantSeq,
// end]` is the inclusive forbidden range — a split at toSeq is unsafe
// iff `assistantSeq <= toSeq < end` for some group.
interface GroupExtent {
  readonly assistantSeq: number;
  readonly end: number;
}

const collectGroups = (events: readonly Event[]): GroupExtent[] => {
  const resultSeqsByCallId = new Map<string, number>();
  for (const e of events) {
    if (e.type === "tool.result") resultSeqsByCallId.set(e.tool_call_id, e.seq);
  }
  const groups: GroupExtent[] = [];
  for (const e of events) {
    if (e.type !== "assistant.message" || !e.tool_calls) continue;
    let end = e.seq;
    let unresolved = false;
    for (const tc of e.tool_calls) {
      const r = resultSeqsByCallId.get(tc.id);
      if (r === undefined) {
        unresolved = true;
        break;
      }
      if (r > end) end = r;
    }
    groups.push({
      assistantSeq: e.seq,
      end: unresolved ? Number.POSITIVE_INFINITY : end,
    });
  }
  return groups;
};

// Why two results: callers (`auto-compact`) want to distinguish "no
// safe boundary at all" from "the only obstruction is an open group"
// to give the model a precise diagnostic.
export type SafeToSeqResult =
  | { readonly kind: "ok"; readonly toSeq: number }
  | { readonly kind: "none"; readonly reason: "unresolved" | "tail" };

// Largest seq s in `[fromSeq, ceiling]` such that no tool-call group
// straddles the split at `(s, s+1)`. Jumps past groups in O(groups) per
// retreat rather than decrementing seq-by-seq, so worst case is
// O(groups²) — negligible for realistic logs.
export const findSafeCompactionToSeq = (
  events: Chunk.Chunk<Event>,
  fromSeq: number,
  ceiling: number,
): SafeToSeqResult => {
  const arr = Chunk.toReadonlyArray(events);
  const groups = collectGroups(arr);

  let toSeq = ceiling;
  let blockedByUnresolved = false;
  while (toSeq >= fromSeq) {
    let nextToSeq: number | null = null;
    for (const g of groups) {
      if (g.assistantSeq < fromSeq) continue; // prior compaction protects this
      if (g.assistantSeq <= toSeq && g.end > toSeq) {
        if (g.end === Number.POSITIVE_INFINITY) blockedByUnresolved = true;
        const candidate = g.assistantSeq - 1;
        if (nextToSeq === null || candidate < nextToSeq) nextToSeq = candidate;
      }
    }
    if (nextToSeq === null) return { kind: "ok", toSeq };
    toSeq = nextToSeq;
  }
  return { kind: "none", reason: blockedByUnresolved ? "unresolved" : "tail" };
};
