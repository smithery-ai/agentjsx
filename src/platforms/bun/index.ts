// Bun runtime adapter.
//
// Provides the full Effect platform surface for Bun: FileSystem, Path,
// CommandExecutor, and the rest of @effect/platform's contract — all
// backed by Bun's native APIs. `<Workspace>` and other capability
// components work without modification.
//
// Usage:
//
//   import { createAgentRuntime } from "@flamecast/agentjsx"
//   import { platform } from "@flamecast/agentjsx/platforms/bun"
//
//   const agent = createAgentRuntime({ platform, infer, context: ... })
//
// Or compose with your own layers:
//
//   import { BunContext } from "@flamecast/agentjsx/platforms/bun"
//   const layer = Layer.merge(BunContext.layer, MyCustomLayer)
//
// `BunRuntime.runMain(program)` is the Bun equivalent of
// `NodeRuntime.runMain` — same signal handling and scope-close
// semantics, just running on Bun.

import { BunContext } from "@effect/platform-bun"

export { BunContext, BunRuntime } from "@effect/platform-bun"
export const platform = BunContext.layer
