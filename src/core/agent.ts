import {
  Chunk,
  Effect,
  Layer,
  ManagedRuntime,
  type Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import type { CommandRuntime, HaltPredicate } from "../jsx/runtime";
import { AgentCtx, type AgentErrorEntry, type Renderer } from "./agent-ctx";
import { runHaltGate } from "./halt-gate";
import { runInference } from "./inference";
import { validateProviderContext } from "./validate";
import { PendingSends } from "./pending-sends";
import { isHalted, lastResult, pendingToolCallsFromLog, toolsInFlight } from "./projections";
import { runToolExecution } from "./tool-exec";
import type { Event, InferFn, ProviderContext, Rendered, Tool, ToolCall } from "./types";

// An Extension is a Layer that consumes AgentCtx (for addTool/addAmbient/
// addTransform) and may also read PendingSends. It contributes nothing
// back into the context graph — its output channel is `never`. The
// lifetime is tied to the surrounding scope, so any resources the
// extension allocates (and any addTool/addAmbient/addTransform finalizers)
// run at agent disposal.
export type Extension = Layer.Layer<never, never, AgentCtx | PendingSends | Scope.Scope>;

export interface AgentOptions {
  readonly system?: string;
  readonly tools?: ReadonlyArray<Tool>;
  readonly extensions?: ReadonlyArray<Extension>;
  readonly infer: InferFn;
  readonly initialEvents?: ReadonlyArray<Event>;
  // Auto-place a cache_control marker on the last ambient block so the
  // full system prefix caches as one chunk on providers that support
  // it (Anthropic et al.). Default true; set false to opt out.
  readonly cacheAmbient?: boolean;
  // Override how ambient + history compose into the Fragment stream. When
  // set, receives the materialized ambient fragments + raw event log and
  // returns the pre-transform Fragment[]. The JSX adapter (`jsxContext`
  // from `@flamecast/harness/jsx`) is one way to build one; any pure
  // function is equally valid.
  readonly renderer?: Renderer;
  // JSX-driven context. When set, each turn the runtime injects the
  // current event log via render()'s ambient context, calls this
  // callback, and uses the returned `Rendered`. Tools are reconciled
  // against the previous turn's tools by name (new → installed in a
  // sub-scope, removed → released, both → left alone). Fragments
  // replace the default ambient+history composition for this branch;
  // user-registered transforms still run on top, so `extensions: [...]`
  // (transforms only) keeps working alongside `context`. When both
  // `context` and `renderer` are set, `context` wins.
  readonly context?: () => Rendered;
  // Render preflight. Invoked just before each inference call with the
  // composed ProviderContext. Returning a string aborts the call: the
  // string is treated as a diagnostic and surfaces as `inference.failed`
  // (so consumers using `agent.until` see it as a terminal event).
  // Returning null lets the call through.
  //
  // Defaults to `validateProviderContext`, which catches
  // empty-assistant-turn shapes that Anthropic / Google / Bedrock reject.
  // Pass `null` to disable (e.g. OpenAI-only callers that tolerate
  // empty-content stop turns).
  readonly validate?: ((ctx: ProviderContext) => string | null) | null;
  // Maximum number of tools that run concurrently within a single tool
  // batch. The model can issue many simultaneous calls; without a cap,
  // rate-limited backends, the filesystem, or subprocess-spawning tools
  // can stampede. Default 8. Pass `"unbounded"` to opt out.
  readonly toolConcurrency?: number | "unbounded";
  // Layer providing host services (typically `@effect/platform`'s
  // FileSystem, Path, CommandExecutor). Required when capability
  // components like <Workspace> are used — those reach for these
  // services via `RenderContext.runEffect`. In Node, pass
  // `NodeContext.layer` from `@effect/platform-node`. Cross-runtime
  // libraries should expose their own composition.
  //
  // Typed broadly (output: any): the runtime doesn't know what
  // services the caller composes in. Capability components that
  // require a specific service fail at use site if it isn't provided,
  // not at composition time. When `platform` is undefined the runtime
  // builds as before — only no platform services are available.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly platform?: Layer.Layer<any, never, never>;
}

// Snapshot view passed into `until` predicates. Plain arrays so
// predicate authors don't need to know about Chunk.
export interface AgentSnapshot {
  readonly events: ReadonlyArray<Event>;
  // Provider-ready render output — the same shape `infer` receives.
  // Renamed from `blocks: Fragment[]` in PR 4; the ProviderContext is
  // the canonical external observation of the render pipeline.
  readonly rendered: ProviderContext;
  readonly errors: ReadonlyArray<AgentErrorEntry>;
}

export interface Agent {
  // Snapshot accessors. Each reads the current value out of the
  // underlying SubscriptionRef. Promise-returning mirrors the signals
  // API where `events()` returns the current array synchronously; here
  // we cross the Effect boundary explicitly.
  readonly events: () => Promise<ReadonlyArray<Event>>;
  readonly rendered: () => Promise<ProviderContext>;
  readonly errors: () => Promise<ReadonlyArray<AgentErrorEntry>>;
  readonly pendingToolCalls: () => Promise<ReadonlyArray<ToolCall>>;
  readonly result: () => Promise<Event | null>;
  // Streams for reactive consumers. SubscriptionRef replays the current
  // value on subscribe so late subscribers never stall.
  readonly eventChanges: Stream.Stream<Chunk.Chunk<Event>>;
  readonly renderedChanges: Stream.Stream<ProviderContext>;
  readonly errorChanges: Stream.Stream<Chunk.Chunk<AgentErrorEntry>>;
  // Resolves once the user.message is durably in the log (or has been
  // queued into PendingSends when tools are in flight). Callers that
  // await this before subscribing to `until` will observe a state that
  // includes the send, avoiding the stale-replay race that a fire-and-
  // forget send introduces. Callers may still ignore the promise — the
  // send is scheduled either way.
  //
  // `input` is the validated value matching the agent's `inputSchema`
  // (string by default; arbitrary shape if the harness exports a custom
  // schema). The runtime does not re-validate here — validation is
  // owned by the API ingest path before the call reaches us.
  readonly run: (input: unknown) => Promise<void>;
  readonly dispose: () => Promise<void>;
  readonly until: <T>(predicate: (snapshot: AgentSnapshot) => T | null) => Promise<T>;
  // Escape hatch for tests and advanced consumers.
  readonly runtime: ManagedRuntime.ManagedRuntime<AgentCtx | PendingSends, never>;
}

// Scoped effect that installs extensions and forks the inference and
// tool-execution loops into the enclosing scope. The scope MUST outlive
// the agent — if the caller closes the scope as soon as this effect
// returns (e.g. by wrapping in `Effect.scoped`), the forked fibers die
// immediately. `createAgentRuntime` wires this into a `Layer` whose
// scope is the managed runtime's lifetime.
export const createAgent = (
  opts: AgentOptions,
): Effect.Effect<AgentCtx, never, AgentCtx | PendingSends | Scope.Scope> =>
  Effect.gen(function* () {
    const ctx = yield* AgentCtx;

    // Extensions install BEFORE forking the inference fiber. Invariant
    // 8: derived state (transforms, extension-added tools) must be
    // complete before the first inference fires on seeded events.
    // `Layer.build` materializes the layer into the enclosing scope so
    // its finalizers run at agent disposal.
    for (const ext of opts.extensions ?? []) {
      yield* Layer.build(ext);
    }

    yield* runInference(opts.infer, {
      // Caller-supplied validator wins; explicit `null` opts out of
      // preflight entirely; absent → default to the canonical empty-
      // assistant guard. The default is conservative-correct for
      // Anthropic / Google / Bedrock; OpenAI-only callers can pass
      // `null` if they prefer to forward empty-content stop turns.
      validate:
        opts.validate === null
          ? null
          : opts.validate ?? validateProviderContext,
    });
    yield* runToolExecution({ concurrency: opts.toolConcurrency ?? 8 });
    // Halt-gate supervisor: runs predicates on each `assistant.halted` and
    // appends a synthetic user.message that re-prompts the model when a
    // goal is unmet. No-op when no predicates are registered.
    yield* runHaltGate(opts.infer);

    return ctx;
  });

// Layer form of `createAgent`. Ties the agent's fibers and extension
// finalizers to whatever scope provides this layer — typically the
// top-level scope of a `ManagedRuntime`, which lives until `dispose`.
// `Layer.scopedDiscard` is the right primitive: it takes a scoped
// effect and produces a no-output layer whose finalizers run on
// scope close.
const agentLayer = (
  opts: AgentOptions,
): Layer.Layer<never, never, AgentCtx | PendingSends> =>
  Layer.scopedDiscard(createAgent(opts));

// Public entry point. Builds a self-contained ManagedRuntime layered
// with AgentCtx + PendingSends, runs the scoped `createAgent` effect,
// and returns a plain-object Agent. Mirrors the signals `createAgent`
// call shape.
export const createAgentRuntime = (opts: AgentOptions): Agent => {
  // Chicken-and-egg: AgentCtx is built by the ManagedRuntime, but the
  // RenderContext that AgentCtx hands to user `context()` callbacks
  // needs `runtime.runPromise` so capability components can run
  // platform-backed Effects. Resolve via a mutable holder: pass a
  // forwarder into AgentCtxOptions, swap in the real runner once the
  // runtime exists. Render() doesn't fire until extensions install (in
  // the agent layer), which is after the runtime is constructed — so
  // by the time anything calls runEffect, the real binding is in place.
  let runEffectRef: <A, E>(eff: Effect.Effect<A, E, never>) => Promise<A> = <
    A,
    E,
  >(
    _eff: Effect.Effect<A, E, never>,
  ): Promise<A> =>
    Promise.reject(
      new Error(
        "Agent runEffect invoked before the runtime finished constructing.",
      ),
    );
  const runEffect = <A, E>(eff: Effect.Effect<A, E, never>): Promise<A> =>
    runEffectRef(eff);
  const ctxLayer = AgentCtx.Default({
    system: opts.system,
    initialTools: opts.tools,
    initialEvents: opts.initialEvents,
    runEffect,
    infer: opts.infer,
    ...(opts.cacheAmbient !== undefined ? { cacheAmbient: opts.cacheAmbient } : {}),
    ...(opts.renderer ? { renderer: opts.renderer } : {}),
    ...(opts.context ? { context: opts.context } : {}),
  });
  // Compose: base services (AgentCtx + PendingSends + optional platform),
  // then the agent fibers/extensions on top. `Layer.provide` flows the
  // base services into agentLayer's dependencies; the resulting layer's
  // lifetime is the managed runtime's lifetime, so inference/tool-exec
  // fibers run until `dispose()` rather than dying when a transient
  // `runPromise` scope closes.
  //
  // Platform layer (FileSystem, Path, CommandExecutor when the caller
  // passes `NodeContext.layer`) merges in as a sibling at the base.
  // Effects executed via `runtime.runPromise` can therefore reach those
  // services. Output type is widened with `as never` because we don't
  // know what the consumer composed in; capability components fail at
  // use site if a required service is missing.
  const platformLayer = opts.platform;
  const baseLayerCore = Layer.merge(ctxLayer, PendingSends.Default);
  const baseLayer = platformLayer
    ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (Layer.merge(baseLayerCore, platformLayer) as Layer.Layer<
        AgentCtx | PendingSends,
        never,
        never
      >)
    : baseLayerCore;
  const fullLayer = Layer.provideMerge(agentLayer(opts), baseLayer);
  const runtime = ManagedRuntime.make(fullLayer);
  // Now that the runtime exists, swap the placeholder runner for the
  // real binding. `runPromise` accepts effects whose R is a subtype of
  // the runtime's provided context; the public `runEffect` signature
  // pins R = never to keep the caller contract simple, but at runtime
  // any service in the merged layer is reachable. Capability components
  // typed against e.g. `FileSystem.FileSystem` reach it through this
  // path; the cast widens the call site without polluting the public R.
  runEffectRef = <A, E>(eff: Effect.Effect<A, E, never>): Promise<A> =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runtime.runPromise(eff as Effect.Effect<A, E, any>);

  // Access the AgentCtx service out of the runtime. ManagedRuntime
  // lazy-builds its layer on first use; grabbing the service forces
  // the build and lets us read snapshots synchronously thereafter.
  const built: Promise<AgentCtx> = runtime.runPromise(
    Effect.gen(function* () {
      return yield* AgentCtx;
    }),
  );

  const withCtx = <A, E = never>(
    fn: (ctx: AgentCtx) => Effect.Effect<A, E>,
  ): Promise<A> => built.then((ctx) => runtime.runPromise(fn(ctx)));

  const events = (): Promise<ReadonlyArray<Event>> =>
    withCtx((ctx) => ctx.events.snapshot.pipe(Effect.map(Chunk.toReadonlyArray)));
  const rendered = (): Promise<ProviderContext> =>
    withCtx((ctx) => SubscriptionRef.get(ctx.rendered));
  const errors = (): Promise<ReadonlyArray<AgentErrorEntry>> =>
    withCtx((ctx) => SubscriptionRef.get(ctx.errors).pipe(Effect.map(Chunk.toReadonlyArray)));
  const pendingToolCallsAcc = (): Promise<ReadonlyArray<ToolCall>> =>
    withCtx((ctx) => ctx.events.snapshot.pipe(Effect.map(pendingToolCallsFromLog)));
  const result = (): Promise<Event | null> =>
    withCtx((ctx) => ctx.events.snapshot.pipe(Effect.map(lastResult)));

  const run = (input: unknown): Promise<void> => {
    const SLASH_RE = /^\/([a-zA-Z_][\w-]*)(?:\s+([\s\S]*))?$/;
    const body: Effect.Effect<
      Promise<void> | null,
      never,
      AgentCtx | PendingSends
    > = Effect.gen(function* () {
      const ctx = yield* AgentCtx;
      const pending = yield* PendingSends;

      // Slash-command router. Only intercepts when input is a string
      // matching `/<ident>(...)`. Looks up the name in the current JSX
      // projection's command list; if matched, runs the handler instead
      // of appending a user.message / triggering inference. Unknown
      // commands fall through with a warning so the model still gets
      // the literal text (lets the model explain that the slash command
      // isn't registered rather than silently dropping the input).
      if (typeof input === "string") {
        const m = input.match(SLASH_RE);
        if (m) {
          const name = m[1]!;
          const args = m[2] ?? "";
          const cmds = yield* SubscriptionRef.get(ctx.commands);
          const cmd = cmds.find((c) => c.name === name);
          if (cmd) {
            // Build the handler-facing CommandRuntime. Each method
            // bridges out of the handler's JS-promise world back into
            // Effect via runtime.runPromise. `appendUserMessage` goes
            // through ctx.events.append so the log remains the single
            // source of truth (no side-channel writes — principle 1
            // in src/CLAUDE.md).
            const cmdRuntime: CommandRuntime = {
              appendUserMessage: (text: string) => {
                void runtime.runPromise(
                  ctx.events.append({ type: "user.message", content: text }),
                );
              },
              registerHaltPredicate: (n: string, fn: HaltPredicate) => {
                void runtime.runPromise(ctx.registerHaltPredicate(n, fn));
              },
              clearHaltPredicate: (n: string) => {
                void runtime.runPromise(ctx.clearHaltPredicate(n));
              },
            };
            // Run the handler outside the Effect fiber — handlers are
            // user JS that may return a Promise. Return the promise so
            // the outer `run` awaits it before resolving.
            const result = cmd.handler({ args, runtime: cmdRuntime });
            return result instanceof Promise ? result : Promise.resolve();
          }
          // Unknown command — warn once and fall through to the normal
          // user.message path.
          console.warn(
            `[agentjsx] received slash input "/${name}" but no command with that name is registered; passing through as user.message`,
          );
        }
      }

      const evs = yield* ctx.events.snapshot;
      if (toolsInFlight(evs)) {
        yield* pending.push(input);
        return null;
      }
      yield* ctx.events.append({ type: "user.message", content: input });
      return null;
    });
    // Ensure the agent has finished building before sending — otherwise
    // seeded extensions could still be installing and a user message
    // could race ahead of them. This matters for the `initialEvents`
    // hydration path where ext-added transforms must be applied before
    // the first inference sees the seeded log. The returned promise
    // resolves only after the append (or pending-sends push) has landed,
    // so callers that `await send` can safely subscribe to `until`
    // without a stale-replay race.
    return built.then(() =>
      runtime.runPromise(body).then((handlerPromise) =>
        handlerPromise ? handlerPromise : undefined,
      ),
    );
  };

  const until = <T>(predicate: (snapshot: AgentSnapshot) => T | null): Promise<T> => {
    const program: Effect.Effect<T, never, AgentCtx | PendingSends> = Effect.gen(function* () {
      const ctx = yield* AgentCtx;
      const merged = Stream.merge(
        ctx.events.changes.pipe(Stream.map((): void => undefined)),
        Stream.merge(
          ctx.rendered.changes.pipe(Stream.map((): void => undefined)),
          ctx.errors.changes.pipe(Stream.map((): void => undefined)),
        ),
      );
      const evaluate: Effect.Effect<T | null> = Effect.gen(function* () {
        const evs = yield* ctx.events.snapshot;
        const rendered = yield* SubscriptionRef.get(ctx.rendered);
        const ers = yield* SubscriptionRef.get(ctx.errors);
        return predicate({
          events: Chunk.toReadonlyArray(evs),
          rendered,
          errors: Chunk.toReadonlyArray(ers),
        });
      });
      const head = yield* merged.pipe(
        Stream.mapEffect(() => evaluate, { concurrency: 1 }),
        Stream.filter((v): v is T => v !== null),
        Stream.runHead,
      );
      if (head._tag === "None") {
        // Stream replays current values so initial evaluation fires.
        // Hitting None means the stream ended — only possible on
        // runtime disposal. Surface a clear error rather than hanging.
        return yield* Effect.die(
          new Error("until: runtime disposed before predicate satisfied"),
        );
      }
      return head.value;
    });
    return built.then(() => runtime.runPromise(program));
  };

  const dispose = (): Promise<void> => runtime.disposeEffect.pipe(Effect.runPromise);

  // Stream accessors defer until the build promise resolves, so the
  // consumer's subscribe lands after the AgentCtx is populated.
  const streamAccessor = <T>(pick: (ctx: AgentCtx) => Stream.Stream<T>): Stream.Stream<T> =>
    Stream.unwrap(Effect.promise(() => built.then(pick)));

  return {
    events,
    rendered,
    errors,
    pendingToolCalls: pendingToolCallsAcc,
    result,
    eventChanges: streamAccessor((ctx) => ctx.events.changes),
    renderedChanges: streamAccessor((ctx) => ctx.rendered.changes),
    errorChanges: streamAccessor((ctx) => ctx.errors.changes),
    run,
    dispose,
    until,
    runtime,
  };
};

// Re-export halt helpers for callers that want to sniff state without
// writing projections themselves.
export { isHalted, lastResult, pendingToolCallsFromLog, toolsInFlight };
