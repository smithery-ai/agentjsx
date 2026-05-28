// Browser runtime adapter.
//
// `@effect/platform-browser` does NOT export a unified context layer
// like Node and Bun do — browsers don't have a uniform FileSystem or
// CommandExecutor surface. What IS available: HTTP client (fetch-
// backed), key-value store (localStorage), WebSocket, plus Clipboard /
// Geolocation / Permissions.
//
// agentjsx's `<Workspace>` requires FileSystem + Path + CommandExecutor
// and will return error strings at tool-call time in browser context
// unless you bring your own layer (e.g., in-memory FileSystem + no-op
// CommandExecutor). The other components — `<Block>`, `<Messages>`,
// `<Compact>`, `<McpServer>` (over HTTP), `<Todo>` — work fine.
//
// Usage:
//
//   import { createAgentRuntime } from "@flamecast/agentjsx"
//   import { partialPlatform } from "@flamecast/agentjsx/platforms/browser"
//
//   const agent = createAgentRuntime({
//     platform: partialPlatform,
//     infer: myFetchBackedInferFn,
//     context: () => render(
//       <Agent>
//         <Block name="role">…</Block>
//         <Messages />
//       </Agent>
//     ),
//   })

import { BrowserHttpClient } from "@effect/platform-browser"

export {
  BrowserHttpClient,
  BrowserKeyValueStore,
  BrowserRuntime,
  BrowserSocket,
  BrowserStream,
  BrowserWorker,
  BrowserWorkerRunner,
  Clipboard,
  Geolocation,
  Permissions,
} from "@effect/platform-browser"

// Partial platform layer for browser context. Wires the HTTP client
// (fetch-backed) because most agent setups need it. No FileSystem,
// no CommandExecutor — bring your own if components need them.
export const partialPlatform = BrowserHttpClient.layerXMLHttpRequest
