import { Effect, Layer } from "effect";
import { AgentCtx } from "../core/agent-ctx";
import type { Extension } from "../core/agent";

// Registers an ambient system block named "cwd" whose content is
// recomputed every time the block projection materializes. The thunk
// is read inside an Effect so the `AmbientProducer.content` Effect-arm is
// exercised — that path is the whole point of Effect-valued content.
//
// Unlike the signals version, this factory does NOT register a `cd`
// tool. Callers who want writable cwd can register their own tool that
// closes over a mutable reference shared with the thunk passed in here.
export const ambientCwd = (getCwd: () => string): Extension =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const ctx = yield* AgentCtx;
      yield* ctx.addAmbient({
        name: "cwd",
        content: Effect.sync(() => `Current working directory: ${getCwd()}`),
      });
    }),
  );
