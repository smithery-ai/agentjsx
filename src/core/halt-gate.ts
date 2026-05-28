import { Chunk, Effect, Ref, Stream } from "effect";
import { AgentCtx } from "./agent-ctx";
import type { Event, InferFn } from "./types";

// Halt-gate supervisor. Watches the event log for "about to return
// control to the user" states, runs all registered halt predicates,
// and — if any returns `ok: false` — appends a synthetic `user.message`
// whose content concatenates the failing reasons. The existing inference
// loop sees the new user.message and triggers another turn, re-prompting
// the model toward the unmet goal.
//
// Two trigger shapes count as "about to halt":
//   1. An explicit `assistant.halted` event (e.g. from `maxSteps`).
//   2. A *natural* terminal — the last event is an `assistant.message`
//      with no `tool_calls` AND no other in-flight tool calls earlier
//      in the turn. This is how `/goal` matches Claude Code's Stop hook
//      semantics: predicates gate every point where the agent would
//      otherwise return to the user, not just forced halts.
//
// In both cases the gate dedupes by the triggering event's `seq` so each
// terminal is judged at most once even if the log churns.
//
// Source of truth: the gate writes a real `user.message` event through
// `ctx.events.append` so the log remains the single durable record
// (principle 1 in src/CLAUDE.md). No side-channel re-prompts.
//
// Concurrency: forked with `Effect.forkScoped`, so the supervisor dies
// with the enclosing agent scope. The fiber subscribes to
// `ctx.events.changes` and is the SOLE consumer that maintains
// "last seen halt seq" state — no other fiber needs that view.
export const runHaltGate = (
  infer: InferFn,
): Effect.Effect<void, never, AgentCtx | import("effect/Scope").Scope> =>
  Effect.gen(function* () {
    const ctx = yield* AgentCtx;
    // Per-seq dedupe. Once a halted seq has been judged (predicates run,
    // either reprompt appended or halt left to stand), we never reprocess
    // that seq — even if the log changes shape later. Set lives only
    // inside this fiber; no cross-fiber sharing.
    const seenRef = yield* Ref.make<ReadonlySet<number>>(new Set());

    // Detect a "natural terminal": last event is `assistant.message`
    // with no tool_calls, and no `tool.call.started` after the most
    // recent `user.message` remains unmatched. Mirrors the inference
    // loop's idle condition.
    const findNaturalTerminalSeq = (
      arr: ReadonlyArray<Event>,
    ): number | null => {
      const last = arr[arr.length - 1];
      if (!last || last.type !== "assistant.message") return null;
      if (last.tool_calls && last.tool_calls.length > 0) return null;
      // Walk back to the last user.message; any tool.call.started since
      // then must have a matching tool.result.
      const started = new Set<string>();
      const finished = new Set<string>();
      for (let i = arr.length - 1; i >= 0; i--) {
        const e = arr[i]!;
        if (e.type === "user.message") break;
        if (e.type === "tool.call.started") started.add(e.tool_call_id);
        else if (e.type === "tool.result") finished.add(e.tool_call_id);
      }
      for (const id of started) {
        if (!finished.has(id)) return null;
      }
      return last.seq;
    };

    const step = (events: Chunk.Chunk<Event>): Effect.Effect<void> =>
      Effect.gen(function* () {
        const arr = Chunk.toReadonlyArray(events);
        const seen = yield* Ref.get(seenRef);
        // Trigger 1: most recent unjudged `assistant.halted` (iterate
        // from tail so the common "just appended" case is O(1)).
        let triggerSeq: number | null = null;
        for (let i = arr.length - 1; i >= 0; i--) {
          const e = arr[i]!;
          if (e.type !== "assistant.halted") continue;
          if (seen.has(e.seq)) break;
          triggerSeq = e.seq;
          break;
        }
        // Trigger 2: natural terminal (assistant.message with no pending
        // tool work). Only used if no halted trigger fired.
        if (triggerSeq === null) {
          const naturalSeq = findNaturalTerminalSeq(arr);
          if (naturalSeq !== null && !seen.has(naturalSeq)) {
            triggerSeq = naturalSeq;
          }
        }
        if (triggerSeq === null) return;
        // Mark this seq judged BEFORE running predicates so a predicate
        // that itself triggers more events (e.g. by calling infer) can't
        // re-enter this step for the same trigger.
        const haltedSeq = triggerSeq;
        yield* Ref.update(seenRef, (s) => {
          const next = new Set(s);
          next.add(haltedSeq);
          return next;
        });

        const predicates = yield* ctx.getHaltPredicates;
        if (predicates.size === 0) return; // halt stands

        const snapshot: ReadonlyArray<Event> = arr;
        const entries = Array.from(predicates.entries());
        // Run predicates in parallel. Predicate throws are caught and
        // mapped to `{ ok: false, reason: "predicate threw: ..." }` so a
        // misbehaving goal can't kill the supervisor.
        const results = yield* Effect.all(
          entries.map(([name, fn]) =>
            Effect.tryPromise({
              try: () => fn({ events: snapshot, infer }),
              catch: (err) => err,
            }).pipe(
              Effect.match({
                onFailure: (err) => ({
                  name,
                  ok: false,
                  reason: `predicate threw: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                }),
                onSuccess: (r) => ({ name, ok: r.ok, reason: r.reason }),
              }),
            ),
          ),
          { concurrency: "unbounded" },
        );

        const failing = results.filter((r) => !r.ok);
        if (failing.length === 0) return; // all goals met — halt stands

        const content = failing
          .map((r) => `[goal: ${r.name}] not met: ${r.reason}`)
          .join("\n");
        yield* ctx.events.append({ type: "user.message", content });
      });

    const driver = ctx.events.changes.pipe(
      Stream.mapEffect((evs) => step(evs), { concurrency: 1 }),
    );
    yield* Effect.forkScoped(Stream.runDrain(driver));
  });
