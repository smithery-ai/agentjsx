// Goal — set a stop condition judged by a separate inference call.
//
// Mount `<Goal />` and the operator can type `/goal <condition>` to
// install a halt predicate. The predicate runs whenever the agent emits
// `assistant.halted`: a side-channel inference call judges whether the
// condition holds against the transcript and returns `{ ok, reason }`.
// `/goal clear` (or `/goal` with no args) removes the predicate.
//
// v1 simplification: the system fragment only shows help text. The
// active condition isn't echoed back into the projection because
// CommandRuntime doesn't expose `appendSystem`. The model learns the
// condition the first time the predicate fails (via its reason string).

import { emitCommand, emitFragment } from "../runtime";
import type { Node } from "../runtime";

export function Goal(): Node {
  return [
    emitFragment({
      tag: "core/system",
      source: "goal",
      content:
        "<goal>(use `/goal <condition>` to set a stop condition; `/goal clear` to remove)</goal>",
    }),
    emitCommand({
      name: "goal",
      description:
        "Set or clear a halt condition judged by a separate inference call.",
      handler: async ({ args, runtime }) => {
        const trimmed = args.trim();
        if (trimmed === "" || trimmed === "clear") {
          runtime.clearHaltPredicate("goal");
          return;
        }
        const condition = trimmed;
        runtime.registerHaltPredicate("goal", async ({ events, infer }) => {
          const transcript = events
            .filter(
              (e) => e.type === "user.message" || e.type === "assistant.message",
            )
            .map((e) => {
              if (e.type === "user.message") {
                const c = e.content;
                return `[user] ${typeof c === "string" ? c : JSON.stringify(c)}`;
              }
              return `[assistant] ${e.content}`;
            })
            .join("\n");
          const system = [
            "You are evaluating a hook condition.",
            `Judge whether this condition holds against the transcript: "${condition}".`,
            'Respond with JSON exactly: {"ok": boolean, "reason": string}. Always include a reason. Quote specific text from the transcript when possible.',
          ].join("\n");
          try {
            const res = await infer({
              system,
              messages: [{ role: "user", content: `TRANSCRIPT:\n${transcript}` }],
              tools: [],
            });
            const raw = res.content.trim();
            const cleaned = raw
              .replace(/^```(?:json)?\s*/i, "")
              .replace(/```$/i, "")
              .trim();
            const parsed = JSON.parse(cleaned);
            if (
              typeof parsed?.ok === "boolean" &&
              typeof parsed?.reason === "string"
            ) {
              return parsed;
            }
            return { ok: false, reason: `judge returned malformed JSON: ${raw}` };
          } catch (e) {
            return {
              ok: false,
              reason: `judge error: ${e instanceof Error ? e.message : String(e)}`,
            };
          }
        });
      },
    }),
  ];
}
