# Effect anti-patterns

The ones experienced Effect users keep flagging. Each has the symptom, the fix, and why it matters.

## 1. Missing `yield*` inside `Effect.gen`

**Symptom:** Code compiles and runs, but the effect never executes. You get an `Effect<...>` value where you expected its result.

```ts
// Wrong
Effect.gen(function* () {
  const x = yield foo()  // yield, not yield*
  return x
})

// Right
Effect.gen(function* () {
  const x = yield* foo()
  return x
})
```

**Why it matters:** Single most common newbie bug. TypeScript usually catches it (`x` is typed as `Effect<...>` instead of the result), but if you immediately pass `x` into something that accepts `Effect`, the type checker is happy and the bug hides.

## 2. `throw` instead of `Effect.fail`

**Symptom:** Errors bypass the `E` channel, surface as defects, can't be caught with `catchTag`.

```ts
// Wrong
const fetchUser = (id: string) =>
  Effect.gen(function* () {
    if (!id) throw new Error("missing id")
    // ...
  })

// Right
class MissingId extends Data.TaggedError("MissingId")<{}> {}
const fetchUser = (id: string) =>
  Effect.gen(function* () {
    if (!id) return yield* Effect.fail(new MissingId())
    // ...
  })
```

**Why:** Tagged errors give you typed `E`, `catchTag` discriminated catching, and visibility in the inferred signature. `throw` becomes a defect (`Cause.Die`) that only `catchAllCause` sees.

## 3. Unbounded `Effect.all` / `Effect.forEach`

**Symptom:** Memory spikes, rate limits, DDoSing your own backend.

```ts
// Wrong
Effect.all(urls.map(fetchUrl))

// Right
Effect.all(urls.map(fetchUrl), { concurrency: 10 })
// Or
Effect.forEach(urls, fetchUrl, { concurrency: 10 })
```

**Why:** Default is unbounded. Almost never what you want for I/O. If you genuinely want sequential, pass `{ concurrency: 1 }` or `{ discard: true }` for fire-and-forget.

## 4. Providing the same Layer in multiple places

**Symptom:** Two instances of a service that should be a singleton. Connections, caches, and pub/sub state silently diverge.

```ts
// Wrong: each handler gets its own DB layer
const handlerA = Effect.gen(...).pipe(Effect.provide(DbLive))
const handlerB = Effect.gen(...).pipe(Effect.provide(DbLive))

// Right: provide once at entry
const program = Effect.all([handlerA, handlerB])
const runnable = program.pipe(Effect.provide(DbLive))
```

**Why:** Layers are memoized within a single `provide`. Two `provide` calls = two layer evaluations = two instances. Use `ManagedRuntime.make` for long-running apps.

## 5. `Effect.runSync` where async is involved

**Symptom:** Runtime error: "Cannot run an async Effect synchronously".

`runSync` only works for genuinely sync effects with no scope. For anything async, use `runPromise` or `runFork`. If you're calling `runSync` to extract a value from middleware, you're probably holding it wrong.

## 6. Methods over namespace functions

**Symptom:** Bundle size larger than expected, dead code not eliminated.

```ts
// Wrong (in modern Effect)
import { Effect } from "effect"
Effect.succeed(1).pipe(eff => eff.map(...))

// Right
import * as Effect from "effect/Effect"
Effect.succeed(1).pipe(Effect.map(...))
```

**Why:** Namespace imports tree-shake. The pipeable function style is what the codebase optimizes for.

## 7. Long `.andThen` / `.flatMap` chains

**Symptom:** Code reads as a single 200-character pipe, hard to debug, hard to add branching.

If you have more than three `.andThen` / `.flatMap` in a row, switch to `Effect.gen`. The early-return and conditional ergonomics in generator form are a massive win for readability.

## 8. `accessors: true` on library services

**Symptom:** Consumers of your library see your service's dependencies leak into their `R` channel via inferred types.

```ts
// Library code
class Foo extends Effect.Service<Foo>()("@me/lib/Foo", {
  effect: Effect.gen(...),
  dependencies: [SomeInternalDep],
  accessors: true,  // ← leaks SomeInternalDep into every caller's inferred R
}) {}
```

For internal app code, `accessors: true` is fine. For published libraries, omit it and export plain functions that use the service internally via `Effect.gen`.

## 9. `forkDaemon` for work that should be `forkScoped`

**Symptom:** Fibers that should die when the request scope ends keep running. Memory leak in long-running processes.

`forkDaemon` detaches from all parent supervision. Use it only when you genuinely mean "this should live until the process ends, and I'll interrupt it manually." For "live until this request/session ends," use `forkScoped`.

## 10. `Data.TaggedError` across a wire

**Symptom:** Errors serialize to `{}` or lose their tag when sent over JSON.

`Data.TaggedError` is in-process. For RPC, SSE, workers, or persisted event logs, use `Schema.TaggedError` so the error round-trips.

## 11. Decoding inside business logic

**Symptom:** `ParseError` showing up deep in your call stack, business logic having to handle decode failures.

Decode at the boundary (HTTP handler, message consumer, model response parser). After decode, internal code works on the typed value. If you're calling `Schema.decode` in the middle of a function, the boundary is in the wrong place.

## 12. Treating `R` as something to clear with `as any`

**Symptom:** Type errors about unresolved requirements; the author silences them with `as any` or `// @ts-expect-error`.

The `R` channel is telling you a dependency isn't provided. The fix is always to provide it (via Layer or `provideService`), never to cast it away. If you're stuck, the layer composition has a hole somewhere upstream.

## 13. `Effect.tryPromise` without error mapping

**Symptom:** Errors come through as `UnknownException` and you've lost all type info.

```ts
// Lossy
Effect.tryPromise(() => fetch(url))

// Better
Effect.tryPromise({
  try: () => fetch(url),
  catch: (e) => new FetchFailed({ cause: e }),
})
```

## 14. Recreating `Effect.gen` semantics with `Promise.all` patterns

**Symptom:** Code reads like "Promises but with `yield*`." You're not benefiting from structured concurrency, interruption, or scope.

If everything's sequential and you don't need fiber control, you may not need Effect for that subprogram. If you do need Effect, lean into its primitives: `Effect.all` with concurrency, `Effect.race`, `Effect.timeout`, `Effect.repeat` with `Schedule`. Don't reimplement them.
