import { Chunk, Effect, Layer } from "effect";
import { AgentCtx, type Event, type Extension } from "@flamecast/agentjsx";

// Hermes "nudges itself to persist knowledge". Concretely: after a
// stretch of activity without a memory write, the model sees a
// reminder fragment encouraging it to reflect on whether anything is
// worth keeping. Pure ambient — no tool, no log writes; it just
// changes what the model sees on the next turn.
//
// Recency is measured in completed turns: each `assistant.message`
// without a pending tool call closes a turn. We walk backwards from
// the log tip, count turns, and surface the nudge if no
// `tool.call.started` for any watched tool appeared in that window.

export interface NudgeOptions {
  // Tool names that count as a "memory write". Default covers the two
  // tools shipped in this harness; extend if you wire others.
  readonly persistTools?: readonly string[];
  // How many completed turns of inactivity before nudging. Default 6.
  readonly threshold?: number;
  readonly message?: string;
}

const DEFAULT_PERSIST_TOOLS = [
  "save_skill",
  "update_skill",
  "update_user_model",
];

const DEFAULT_MESSAGE =
  "Reflection nudge: it's been several turns since you saved anything to memory. " +
  "If something from this session is worth keeping for next time — a workflow, a " +
  "user preference, a sharp edge to remember — call `save_skill` or " +
  "`update_user_model`. If nothing fits, ignore this and continue.";

export const nudge = (opts: NudgeOptions = {}): Extension => {
  const persistTools = new Set(opts.persistTools ?? DEFAULT_PERSIST_TOOLS);
  const threshold = opts.threshold ?? 6;
  const message = opts.message ?? DEFAULT_MESSAGE;

  return Layer.scopedDiscard(
    Effect.gen(function* () {
      const ctx = yield* AgentCtx;
      const eventLog = ctx.events;

      yield* ctx.addAmbient({
        name: "hermes/nudge",
        content: Effect.gen(function* () {
          const snapshot = yield* eventLog.snapshot;
          const events = Chunk.toReadonlyArray(snapshot);
          let turns = 0;
          for (let i = events.length - 1; i >= 0; i -= 1) {
            const ev = events[i] as Event;
            if (
              ev.type === "tool.call.started" &&
              persistTools.has(ev.tool_name)
            ) {
              return "";
            }
            if (ev.type === "assistant.message" && !ev.tool_calls?.length) {
              turns += 1;
              if (turns < threshold) continue;
              return message;
            }
          }
          return "";
        }),
      });
    }),
  );
};
