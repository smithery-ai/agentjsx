import { Chunk } from "effect";
import { describe, expect, it } from "vitest";
import { findSafeCompactionToSeq } from "@flamecast/agentjsx/compaction";
import { renderHistoryFragments } from "@flamecast/agentjsx";
import type { Fragment, Event, ToolCall } from "@flamecast/agentjsx";

// Tool-call atomicity: every `core/tool-result` fragment must follow an
// `core/assistant-message` whose `toolCalls` contain its `toolCallId`.
// The projection's output is sent directly to provider APIs; violating
// this invariant produces a 400 ("tool_result without matching tool_use").
const assertToolGroupsIntact = (blocks: Fragment[]): void => {
  const seenCallIds = new Set<string>();
  for (const b of blocks) {
    if (b.tag === "core/assistant-message" && b.toolCalls) {
      for (const tc of b.toolCalls) seenCallIds.add(tc.id);
    } else if (b.tag === "core/tool-result") {
      if (!b.toolCallId || !seenCallIds.has(b.toolCallId)) {
        throw new Error(
          `orphan tool block: toolCallId=${b.toolCallId || "<missing>"}`,
        );
      }
    }
  }
};

const tc = (id: string): ToolCall => ({
  id,
  type: "function",
  function: { name: "fn", arguments: "{}" },
});

// Canonical interleaved log: turn A uses tool1, turn B uses tool2, turn
// C is a plain reply. `toSeq = 3` splits through turn B's tool group
// (assistant.message with tool_call_id=t2 at seq 3; matching tool.result
// at seq 4) — the pre-fix bug.
const makeInterleavedLog = (): Chunk.Chunk<Event> =>
  Chunk.fromIterable<Event>([
    { seq: 0, type: "user.message", content: "u1" },
    { seq: 1, type: "assistant.message", content: "", tool_calls: [tc("t1")] },
    { seq: 2, type: "tool.result", tool_call_id: "t1", content: "r1" },
    { seq: 3, type: "assistant.message", content: "", tool_calls: [tc("t2")] },
    { seq: 4, type: "tool.result", tool_call_id: "t2", content: "r2" },
    { seq: 5, type: "assistant.message", content: "done" },
  ]);

describe("findSafeCompactionToSeq", () => {
  it("retreats past a group that straddles the split", () => {
    const log = makeInterleavedLog();
    // Ceiling 3 straddles turn B's group; retreat lands at seq 2 (end of turn A).
    expect(findSafeCompactionToSeq(log, 0, 3)).toEqual({ kind: "ok", toSeq: 2 });
  });

  it("accepts a boundary at the end of a complete group", () => {
    const log = makeInterleavedLog();
    expect(findSafeCompactionToSeq(log, 0, 2)).toEqual({ kind: "ok", toSeq: 2 });
    expect(findSafeCompactionToSeq(log, 0, 4)).toEqual({ kind: "ok", toSeq: 4 });
  });

  it("reports 'tail' when no safe boundary exists in the window", () => {
    const log = Chunk.fromIterable<Event>([
      { seq: 0, type: "assistant.message", content: "", tool_calls: [tc("t1")] },
      { seq: 1, type: "tool.result", tool_call_id: "t1", content: "r1" },
    ]);
    // Group spans 0..1; asking to compact only seq 0 has no safe cut.
    expect(findSafeCompactionToSeq(log, 0, 0)).toEqual({
      kind: "none",
      reason: "tail",
    });
  });

  it("reports 'unresolved' when a still-running tool call blocks the window", () => {
    const log = Chunk.fromIterable<Event>([
      { seq: 0, type: "assistant.message", content: "", tool_calls: [tc("t1")] },
    ]);
    // The only event IS the unresolved call — no safe cut at or after it.
    expect(findSafeCompactionToSeq(log, 0, 0)).toEqual({
      kind: "none",
      reason: "unresolved",
    });
  });

  it("retreats past an unresolved group but still succeeds when earlier seqs are safe", () => {
    const log = Chunk.fromIterable<Event>([
      { seq: 0, type: "user.message", content: "u" },
      { seq: 1, type: "assistant.message", content: "", tool_calls: [tc("t1")] },
    ]);
    // Ceiling 1 is inside the open group; retreat lands at seq 0 (safe).
    expect(findSafeCompactionToSeq(log, 0, 1)).toEqual({ kind: "ok", toSeq: 0 });
  });

  it("handles parallel tool_calls in a single assistant turn", () => {
    // Assistant at seq 1 issues two calls; results land at seqs 2 and 3.
    const log = Chunk.fromIterable<Event>([
      { seq: 0, type: "user.message", content: "u" },
      {
        seq: 1,
        type: "assistant.message",
        content: "",
        tool_calls: [tc("a"), tc("b")],
      },
      { seq: 2, type: "tool.result", tool_call_id: "a", content: "r-a" },
      { seq: 3, type: "tool.result", tool_call_id: "b", content: "r-b" },
      { seq: 4, type: "assistant.message", content: "done" },
    ]);
    // Ceiling 2 splits the parallel group (call at 1, result-b at 3 is past toSeq=2).
    expect(findSafeCompactionToSeq(log, 0, 2)).toEqual({ kind: "ok", toSeq: 0 });
    // Ceiling 3 covers the whole group.
    expect(findSafeCompactionToSeq(log, 0, 3)).toEqual({ kind: "ok", toSeq: 3 });
  });

  it("respects fromSeq so prior compactions don't re-obstruct the retreat", () => {
    // Prior compaction covered [0, 2]. A NEW group lives at seqs 4..5.
    // The retreat should consider only obstacles with assistantSeq >= fromSeq.
    const log = Chunk.fromIterable<Event>([
      { seq: 0, type: "user.message", content: "u1" },
      { seq: 1, type: "assistant.message", content: "", tool_calls: [tc("t1")] },
      { seq: 2, type: "tool.result", tool_call_id: "t1", content: "r1" },
      { seq: 3, type: "compaction.summary", fromSeq: 0, toSeq: 2, text: "S1" },
      { seq: 4, type: "assistant.message", content: "", tool_calls: [tc("t2")] },
      { seq: 5, type: "tool.result", tool_call_id: "t2", content: "r2" },
      { seq: 6, type: "assistant.message", content: "ok" },
    ]);
    // fromSeq = 3 (after the prior boundary). Ceiling 4 would straddle the
    // t2 group (call at 4, result at 5) → retreat to 3.
    expect(findSafeCompactionToSeq(log, 3, 4)).toEqual({ kind: "ok", toSeq: 3 });
    expect(findSafeCompactionToSeq(log, 3, 5)).toEqual({ kind: "ok", toSeq: 5 });
  });
});

describe("projection preserves tool-call atomicity across compaction", () => {
  it("unsafe boundary orphans tool.result blocks (demonstrates the pre-fix bug)", () => {
    // Simulate the OLD behavior: boundary at ceiling = 3 straddles turn B's group.
    const events = Chunk.appendAll(
      makeInterleavedLog(),
      Chunk.fromIterable<Event>([
        { seq: 6, type: "compaction.summary", fromSeq: 0, toSeq: 3, text: "S" },
      ]),
    );
    const blocks = renderHistoryFragments(events);
    // Turn B's assistant.message(tool_calls=t2) is inside the compacted
    // range; its tool.result at seq 4 survives in the tail → orphan.
    expect(() => assertToolGroupsIntact(blocks)).toThrow(/orphan tool block/);
  });

  it("safe boundary keeps every tool.result paired with its assistant call", () => {
    const log = makeInterleavedLog();
    const safe = findSafeCompactionToSeq(log, 0, 3);
    expect(safe).toEqual({ kind: "ok", toSeq: 2 });
    if (safe.kind !== "ok") return;
    const events = Chunk.appendAll(
      log,
      Chunk.fromIterable<Event>([
        {
          seq: 6,
          type: "compaction.summary",
          fromSeq: 0,
          toSeq: safe.toSeq,
          text: "S",
        },
      ]),
    );
    const blocks = renderHistoryFragments(events);
    expect(() => assertToolGroupsIntact(blocks)).not.toThrow();
  });

  it("stacked safe compactions keep the whole projection well-formed", () => {
    // First compaction covers [0, 2]; second covers [3, 5]. Both land on
    // group boundaries, so the projected blocks are: [sys, sys, assistant].
    const log = Chunk.fromIterable<Event>([
      { seq: 0, type: "user.message", content: "u1" },
      { seq: 1, type: "assistant.message", content: "", tool_calls: [tc("t1")] },
      { seq: 2, type: "tool.result", tool_call_id: "t1", content: "r1" },
      { seq: 3, type: "assistant.message", content: "", tool_calls: [tc("t2")] },
      { seq: 4, type: "tool.result", tool_call_id: "t2", content: "r2" },
      { seq: 5, type: "assistant.message", content: "mid" },
      { seq: 6, type: "compaction.summary", fromSeq: 0, toSeq: 2, text: "S1" },
      { seq: 7, type: "compaction.summary", fromSeq: 3, toSeq: 5, text: "S2" },
      { seq: 8, type: "user.message", content: "more" },
    ]);
    const blocks = renderHistoryFragments(log);
    expect(() => assertToolGroupsIntact(blocks)).not.toThrow();
    const systemBlocks = blocks.filter((b) => b.source === "compaction");
    expect(systemBlocks).toHaveLength(2);
  });
});
