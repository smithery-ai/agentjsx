import type { Event } from "./types";

// Pair every dangling tool_call with a synthetic `[interrupted]` tool.result.
// A tool_call is dangling when:
//   (1) an `assistant.message` declares a tool_call id that has no matching
//       `tool.call.started` beacon AND no `tool.result` for that id, or
//   (2) a `tool.call.started` beacon has no matching `tool.result`.
//
// Both indicate a mid-tool-call crash. Auto-re-dispatch would duplicate
// non-idempotent side effects (send_slack_message, charge_card). Synthesizing
// an interrupted result advances the log so the LLM resumes with explicit
// ambiguity and can verify externally.
//
// Pure — no Effect machinery. Callable from any context, including when
// seeding a `SubscriptionRef<Chunk<Event>>` at agent construction time.
export function reconcileHydrationDangling(events: readonly Event[]): Event[] {
  if (events.length === 0) return events as Event[];

  const resulted = new Set<string>();
  for (const e of events) {
    if (e.type === "tool.result") resulted.add(e.tool_call_id);
  }

  const dangling: string[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (e.type === "assistant.message" && e.tool_calls) {
      for (const tc of e.tool_calls) {
        if (!resulted.has(tc.id) && !seen.has(tc.id)) {
          dangling.push(tc.id);
          seen.add(tc.id);
        }
      }
    }
    if (e.type === "tool.call.started") {
      if (!resulted.has(e.tool_call_id) && !seen.has(e.tool_call_id)) {
        dangling.push(e.tool_call_id);
        seen.add(e.tool_call_id);
      }
    }
  }

  if (dangling.length === 0) return [...events];

  let nextSeq = events.length;
  return [
    ...events,
    ...dangling.map(
      (tool_call_id): Event => ({
        seq: nextSeq++,
        type: "tool.result",
        tool_call_id,
        content:
          "[interrupted: tool call was in flight when the runtime restarted. Outcome unknown. Verify externally if needed.]",
      }),
    ),
  ];
}
