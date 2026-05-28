// Bun runtime adapter. Re-exports BunContext from @effect/platform-bun.
// Consumers: `import { platform } from "@flamecast/agentjsx/platforms/bun"`
//            createAgentRuntime({ platform, ... })

import { BunContext } from "@effect/platform-bun"

export { BunContext }
export const platform = BunContext.layer
