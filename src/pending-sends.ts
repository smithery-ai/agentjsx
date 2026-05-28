import { Chunk, Effect, Queue } from "effect";

// Pending-send buffer. When `send()` is called while a tool batch is in
// flight, we cannot append `user.message` directly: the tool-execution
// loop appends results after `tool.run` completes, which would place
// `tool.result` AFTER the mid-call `user.message` and sever the
// assistant↔tool_result adjacency OpenAI requires. Buffer the message
// instead; the tool-execution loop drains after results land.
//
// A dedicated service makes the ownership explicit — producer is
// `send()`, consumer is the tool-execution fiber. Both pull the queue
// from the context rather than closing over a shared mutable.

export interface PendingSendsService {
  readonly push: (content: unknown) => Effect.Effect<void>;
  readonly drainAll: Effect.Effect<ReadonlyArray<unknown>>;
}

export class PendingSends extends Effect.Service<PendingSends>()("@flamecast/agentctx/PendingSends", {
  scoped: Effect.gen(function* () {
    const queue = yield* Queue.bounded<unknown>(1024);
    const push = (content: unknown): Effect.Effect<void> =>
      Queue.offer(queue, content).pipe(Effect.asVoid);
    const drainAll: Effect.Effect<ReadonlyArray<unknown>> = Queue.takeAll(queue).pipe(
      Effect.map((chunk) => Chunk.toReadonlyArray(chunk)),
    );
    const service: PendingSendsService = { push, drainAll };
    return service;
  }),
}) {}
