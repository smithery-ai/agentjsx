// Cloudflare Workers (workerd) runtime adapter — STUB.
//
// Status: no upstream `@effect/platform-workerd` exists on npm. The
// agentjsx integration is blocked on either:
//
//   - Effect shipping a workerd platform package (community work in
//     progress; check the Effect-TS GitHub org for status)
//   - This package providing its own minimal workerd layer (no-op
//     CommandExecutor, KV / R2-backed FileSystem, fetch-based
//     HttpClient). Open an issue if you want to design this.
//
// In the meantime, agentjsx CAN run in Cloudflare Workers without a
// platform layer — most components don't need one. The constraints:
//
//   - Omit `<Workspace>` (no fs / no shell in workerd)
//   - Provide a custom `InferFn` that uses the Workers fetch API
//   - `<McpServer>` works fine (HTTP-based)
//   - `<Block>`, `<Messages>`, `<Compact>`, `<Todo>` all work
//   - Leave `platform` undefined in `createAgentRuntime({ ... })` —
//     <Workspace> would have degraded to error-string tool returns
//     anyway; everything else is platform-agnostic

export {}
