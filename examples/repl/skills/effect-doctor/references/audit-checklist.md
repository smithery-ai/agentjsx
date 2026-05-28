# Effect-TS audit checklist

Walk this in order. For each item, either confirm the code is fine or record a finding with `file:line` and a severity tag:

- `[bug]` — will misbehave at runtime
- `[idiom]` — works but not canonical
- `[smell]` — worth a second look

## 1. Layer composition (10 min)

- [ ] Every Layer constructor matches its job (`effect` for stateless, `scoped` for resources, `scopedDiscard` for env patches). Look for `Layer.effect` where the construction effect uses `acquireRelease` or `addFinalizer` — that should be `scoped`.
- [ ] Each Layer is provided exactly once at the entry boundary. Grep for repeated `Effect.provide(SomeLive)` calls.
- [ ] No god-layers. If a single Layer is composed from more than ~6 sub-layers, check whether it should be split.
- [ ] Tag identifiers follow `"@scope/pkg/ServiceName"`. Bare names (e.g. `"Db"`) are a smell.
- [ ] `ManagedRuntime.make` (or equivalent) is used for long-running entries. Bare `Effect.runPromise` at the top of a server handler is suspicious.

## 2. Services (5 min)

- [ ] `Effect.Service` class form unless there's a reason to use raw `Context.Tag`.
- [ ] `accessors: true` is absent on library-public services (it leaks `R`).
- [ ] Every service that has a default impl ships a `Live` Layer next to it.
- [ ] No methods on the service interface require `R` in their return type. Dependencies go on the constructing Layer.

## 3. Errors (10 min)

- [ ] Public functions have a precise `E` channel (2-4 documented errors, not a wide union).
- [ ] In-process errors use `Data.TaggedError`. Errors that cross a wire (RPC, SSE, worker, persisted event log) use `Schema.TaggedError`.
- [ ] No `throw` statements inside Effect-returning code (except in `Effect.try` / `tryPromise` callbacks). Grep for `throw new`.
- [ ] `Effect.die` is used only for genuine invariant violations.
- [ ] `Effect.tryPromise` always has an explicit `catch` mapping the error.

## 4. Resource management (5 min)

- [ ] Anything that acquires a resource releases it via `acquireRelease` or `addFinalizer`. No bare `try/finally` inside Effect code.
- [ ] Per-request work inside a long-running runtime is wrapped in `Effect.scoped` so resources don't accumulate.
- [ ] Finalizers handle the `Exit` they receive when behavior should differ on success/failure/interrupt.

## 5. Concurrency and fibers (10 min)

- [ ] Every `Effect.all` and `Effect.forEach` over a collection has explicit `{ concurrency: ... }`. Unbounded is almost never correct for I/O.
- [ ] `forkDaemon` is used only when the work genuinely should outlive every scope. Otherwise it's `forkScoped`.
- [ ] Shared mutable state goes through `Ref` / `SynchronizedRef`, not raw closures.
- [ ] Cross-fiber coordination uses `Deferred`, `Queue`, `PubSub`, or `Semaphore` — not ad-hoc state.

## 6. Streams (5 min)

- [ ] Things that produce zero-or-more values over time are `Stream`, not arrays accumulated inside an `Effect`.
- [ ] Multi-consumer broadcast uses `PubSub` + `Stream.fromPubSub`.
- [ ] Back-pressure strategy (`bounded`/`dropping`/`sliding`/`unbounded`) is chosen explicitly, not left at default.

## 7. Schema (5 min)

- [ ] Decode happens at boundaries (HTTP, message consumers, model responses). No `Schema.decode*` calls deep in business logic.
- [ ] Internal types are the decoded shape, not the encoded one.
- [ ] Schemas are exported (not just inferred types) so consumers can derive validators, OpenAPI, tool definitions.

## 8. Tracing and observability (5 min)

- [ ] Each meaningful unit of work has an `Effect.withSpan` wrapper.
- [ ] Span attributes follow OTel semantic conventions where they exist (`gen_ai.*` for AI calls, `http.*` for requests, `db.*` for queries).
- [ ] `@effect/opentelemetry` Layer is provided once at the entry, not per-request.

## 9. Idiom and bundle (5 min)

- [ ] Imports are namespace style: `import * as Effect from "effect/Effect"`. The barrel `import { Effect } from "effect"` is OK for small apps but breaks tree-shaking in libraries.
- [ ] `Effect.gen` is used for control flow with branching; `.pipe` for linear transformations. Long `.andThen` chains are a smell.
- [ ] No `as any` clearing the `R` channel. If `R` is leaking, the Layer composition has a hole.

## 10. Library-specific (if you're auditing a library) (5 min)

- [ ] Public API exposes both services and default Layers.
- [ ] Error channel in public functions is small and named.
- [ ] No internal types leak into public signatures via inferred return types.
- [ ] Schemas are part of the public exports.
- [ ] The package is platform-agnostic; runtime-specific bits live in a sub-export (e.g. `pkg/node`, `pkg/browser`).

## Reporting

Group findings by section. For each:

```
[severity] section/file:line
  Finding: <one sentence>
  Suggestion: <one sentence>
```

End with a 2-3 sentence summary of the overall shape of the code. Don't editorialize beyond that. Let the user decide which findings to act on.
