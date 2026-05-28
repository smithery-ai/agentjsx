// Cloudflare Workers (workerd) runtime adapter.
//
// Placeholder: no stable @effect/platform package for workerd exists
// as of this writing. When Effect ships one (or we build our own),
// this module will export the corresponding Context + platform layer.
//
// For Cloudflare Workers today, consumers can:
//   - Use the Sandbox-backed adapters via examples/cloudflare-sandbox
//     (older pattern, pre-JSX components)
//   - Stub the platform layer with FileSystem.layerNoop + skip shell
//     operations (workspace tools will fail with clear errors)

export {}
