# Effect primitives: decision tables

Quick lookups when you're not sure which primitive to reach for.

## Layer constructors

| Situation | Use |
|---|---|
| Service is stateless (just functions over deps) | `Layer.effect(Tag, eff)` |
| Construction uses `acquireRelease` or `addFinalizer` | `Layer.scoped(Tag, eff)` |
| You're patching the environment (Clock, ConfigProvider, FiberRef) with no service surface | `Layer.scopedDiscard(eff)` |
| Same as above but no scope needed | `Layer.effectDiscard(eff)` |
| You already have a value, not an Effect | `Layer.succeed(Tag, value)` |
| Bundling Tag + default Layer in one declaration | `Effect.Service` class form |

`Layer.scoped`'s signature excludes `Scope` from requirements (`Layer<I, E, Exclude<R, Scope>>`). That's the tell that it's the right choice when finalizers are involved.

## Layer composition

| Situation | Use |
|---|---|
| Combine independent layers into one (union of outputs) | `Layer.merge(A, B)` |
| B depends on A's output; only B's output is exposed | `Layer.provide(B, A)` |
| B depends on A; expose both outputs | `Layer.provideMerge(B, A)` |
| Provide a layer to an effect | `Effect.provide(eff, layer)` |
| Provide a single value | `Effect.provideService(eff, Tag, value)` |

## Error: fail vs die

| Situation | Use |
|---|---|
| Caller should handle this; appears in `E` | `Effect.fail(new TaggedError(...))` |
| Invariant violation, "should never happen" | `Effect.die(new Error(...))` |
| Catching expected errors | `Effect.catchTag` / `catchTags` / `catchAll` |
| Catching defects too | `Effect.catchAllCause` / `Effect.sandbox` |

`fail` keeps the error in `E`; `die` puts it in the `Cause` as a defect, invisible to `catchAll`.

## Error: Data vs Schema

| Situation | Use |
|---|---|
| Normal in-process error | `Data.TaggedError("Foo")<{...}>` |
| Crosses a wire (RPC, SSE, worker, persistence) | `Schema.TaggedError` |
| ADT branches with `_tag` discriminator | `Schema.TaggedClass` or `Schema.TaggedStruct` |

## Fibers

| Situation | Use |
|---|---|
| Concurrent work that should die with parent | `Effect.fork` |
| Work that outlives the originating effect but not the runtime | `Effect.forkScoped` |
| Truly detached background work, manual shutdown | `Effect.forkDaemon` (rare; foot-gun) |
| Explicit scope parameter | `Effect.forkIn(scope)` |

## Concurrency

| Situation | Use |
|---|---|
| Parallel work over a collection | `Effect.all(arr, { concurrency: n })` or `forEach` with concurrency |
| Rate-limited access to a resource | `Semaphore` |
| Single-consumer back-pressured queue | `Queue` (bounded/dropping/sliding/unbounded) |
| Multi-consumer broadcast | `PubSub` + `Stream.fromPubSub` per subscriber |
| Coordination primitives | `Deferred`, `Ref`, `SynchronizedRef` |

**Never** call `Effect.all` without `{ concurrency }` when the array could be large. Default is unbounded.

## Stream vs Effect

| Situation | Use |
|---|---|
| Single result (possibly async) | `Effect` |
| Zero-or-more values over time | `Stream` |
| Stream that needs back-pressure across consumers | `Stream.fromQueue` / `fromPubSub` |
| Convert a Promise-returning callback API | `Stream.async` |

For AI/agent token streams: `Stream`. `@effect/ai`'s `streamText` already returns one.

## Runtime entry

| Situation | Use |
|---|---|
| Top-level Node script | `Effect.runPromise(eff)` or `runPromiseExit` |
| Fire-and-forget with handle | `Effect.runFork` |
| Genuinely sync effect (no async, no scope) | `Effect.runSync` (rare; throws otherwise) |
| Long-running app with shared layers | `ManagedRuntime.make(layer)` then `runtime.runPromise(eff)` |
| Letting a layer manage its own lifecycle | `Layer.launch(layer)` |

## Schema

| Situation | Use |
|---|---|
| Plain record | `Schema.Struct({...})` |
| ADT branch with `_tag` | `Schema.TaggedStruct("Tag", {...})` or `Schema.TaggedClass` |
| Decode unknown input at boundary | `Schema.decodeUnknown(schema)(input)` (returns `Effect`) |
| Encode for transport | `Schema.encode(schema)(value)` |
| Sync decode (throws on error) | `Schema.decodeUnknownSync` (only when you're sure) |
