// Cloudflare vendor helpers — STUB.
//
// Reserved for Cloudflare-specific adapters that aren't part of the
// workerd runtime layer itself:
//
//   - R2-backed FileSystem (object storage shaped as a filesystem)
//   - D1 binding helpers (SQL client via @effect/sql)
//   - Workers AI as an InferFn (Cloudflare's hosted models)
//   - Durable Object utilities
//
// These are vendor-specific bindings, distinct from the runtime contract
// at /platforms/worker. Both can co-exist in a deployment.
//
// Nothing shipped yet. Open an issue or PR when adding a binding.

export {}
