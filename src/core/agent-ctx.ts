import {
  Chunk,
  Effect,
  Equal,
  Exit,
  PubSub,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import { DuplicateToolError } from "./errors";
import { makeEventLog, type EventLog } from "./event-log";
import { _clearExternalContext, _setExternalContext } from "../jsx/render";
import { renderHistoryFragments } from "./projections";
import { adaptToProviderContext } from "./render-adapter";
import type {
  CacheControl,
  Event,
  Fragment,
  FragmentMap,
  InferFn,
  ProviderContext,
  Rendered,
  TextDelta,
  Tool,
} from "./types";

const TEXT_DELTA_CAPACITY = 256;

// An `AmbientProducer` is an extension's contribution to the fragment
// stream. By default it produces a `core/system` fragment from `content`
// (plain string or Effect-valued for dynamic extensions like ambient-cwd).
// `cacheControl` opts into provider-side prompt caching: set on the
// last long-lived fragment in the system prefix (skills menu, workspace
// tree) so the provider caches everything up to and including this
// fragment. `tag` is reserved for future typed ambient fragments; today
// ambients always materialize as `core/system` and `tag` is informational.
export interface AmbientProducer {
  readonly name: string;
  readonly content: string | Effect.Effect<string>;
  readonly cacheControl?: CacheControl;
  // Fragment tag this producer emits. Defaults to `"core/system"` — the
  // only variant the default materializer supports today. Future work
  // (PR 3+) may thread this through to produce typed non-system ambients.
  readonly tag?: keyof FragmentMap;
}

// Pre-resolved context passed to every transform invocation. Lets
// transforms depend on reactive framework state (tools, etc.) without
// reaching into Effect primitives at transform time. The render driver
// subscribes to the underlying refs, so transforms re-run with
// fresh `tctx` on any relevant change. Extend this structurally as new
// needs emerge; keep the surface minimal.
export interface TransformContext {
  readonly tools: readonly Tool[];
}

export interface Transform {
  readonly name: string;           // human-readable, surfaced in diagnostics; not required unique
  readonly run: (fragments: Fragment[], tctx: TransformContext) => Fragment[];
}

export interface AgentErrorEntry {
  readonly phase: string;
  readonly error: unknown;
}

// Inputs to a custom `renderer` hook. Ambient fragments are already
// materialized (Effect-valued AmbientProducer content is resolved before
// calling the hook), so the composer can arrange them alongside the
// history however it likes.
export interface ProjectionInputs {
  readonly events: ReadonlyArray<Event>;
  readonly ambient: ReadonlyArray<Fragment>;
}

// A pure composer that replaces the default "ambient + history"
// composition. Any function from inputs to Fragment[] works — the JSX
// adapter (`jsxContext` in `@flamecast/harness/jsx`) is one option, but
// a plain function is equally valid. The return value is passed through
// the registered `transforms` chain, so snip/truncate/clip continue to
// apply on top.
export type Renderer = (
  inputs: ProjectionInputs,
) => ReadonlyArray<Fragment>;

export interface AgentCtxOptions {
  readonly system?: string;
  readonly initialTools?: ReadonlyArray<Tool>;
  readonly initialEvents?: ReadonlyArray<Event>;
  // Opt into provider-side prompt caching by marking the last ambient
  // (system-prefix) fragment with `cacheControl: { type: "ephemeral" }`.
  // Anthropic-style caching covers everything up to and including the
  // marked fragment, so this caches the full ambient prefix in a single
  // breakpoint. Safe default because providers that don't support it
  // ignore the marker. Set false to disable.
  readonly cacheAmbient?: boolean;
  // Custom context composer. When set, replaces the default "ambient +
  // history" composition. Transforms still apply on top. Any pure
  // function from inputs to Fragment[] works; `jsxContext` from
  // `@flamecast/harness/jsx` adapts a JSX builder into this shape.
  readonly renderer?: Renderer;
  // JSX-driven context. When set, takes precedence over `renderer`: the
  // render driver calls this each turn (with the current event log
  // injected via the render() ambient context), takes the returned
  // `Rendered`, reconciles its tool list against the previous render's
  // tools (by name), and uses its fragments as the pre-transform stream.
  readonly context?: () => Rendered;
  // Runner that executes Effects against the enclosing agent runtime.
  // Threaded through to the render() ambient RenderContext so capability
  // components can call platform services from inside Tool.run bodies.
  // Injected by `createAgentRuntime` after the runtime is constructed
  // (chicken-and-egg: AgentCtx is built by the runtime, but the runtime
  // is the thing that supplies the runner). Until the runtime swaps in
  // the real runner, calls throw — render() walks during construction
  // shouldn't be invoking it, so the placeholder is a fine fallback.
  readonly runEffect?: <A, E>(eff: Effect.Effect<A, E, never>) => Promise<A>;
  // Inference function exposed to capability components via the JSX
  // RenderContext. Optional because AgentCtx is also used standalone in
  // tests that never invoke inference; when absent, components that
  // call `ctx.infer` fail at use time with a clear message. Wired by
  // `createAgentRuntime` from `AgentOptions.infer`.
  readonly infer?: InferFn;
}

export interface AgentCtxService {
  readonly events: EventLog;
  readonly tools: SubscriptionRef.SubscriptionRef<Chunk.Chunk<Tool>>;
  readonly ambients: SubscriptionRef.SubscriptionRef<Chunk.Chunk<AmbientProducer>>;
  readonly transforms: SubscriptionRef.SubscriptionRef<Chunk.Chunk<Transform>>;
  readonly errors: SubscriptionRef.SubscriptionRef<Chunk.Chunk<AgentErrorEntry>>;
  // Materialized provider-ready render output. Maintained by the
  // render fiber; read by single-observation consumers (UI, `until`
  // predicates, tests, external dumps). Never by fibers also
  // subscribed to `events.changes` — those must call `render` (below)
  // to avoid the FRP glitch.
  readonly rendered: SubscriptionRef.SubscriptionRef<ProviderContext>;
  // Synchronous render from primary sources (events + ambients +
  // transforms + tools). Runs the shaper chain AND the terminal
  // adapter, so the result is the same ProviderContext shape the
  // materialized `rendered` ref holds. Use this — not `rendered` —
  // anywhere the caller MUST observe a context consistent with a
  // specific events state (notably the inference loop). The
  // materialized `rendered` ref is maintained by a forked render
  // fiber, so consumers also forked off `events.changes` would race it
  // and read a stale snapshot.
  readonly render: Effect.Effect<ProviderContext>;
  readonly addTool: (tool: Tool) => Effect.Effect<void, DuplicateToolError, Scope.Scope>;
  readonly addAmbient: (source: AmbientProducer) => Effect.Effect<void, never, Scope.Scope>;
  readonly addTransform: (transform: Transform) => Effect.Effect<void, never, Scope.Scope>;
  readonly reportError: (phase: string, err: unknown) => Effect.Effect<void>;
  // Trigger a re-render. Use for extensions whose reactive state
  // lives outside the standard render inputs (events / ambients /
  // transforms / tools) — e.g. a Ref that influences a transform's
  // output. After writing to such a Ref, call `invalidate` so
  // downstream subscribers observe the new fragments. Without this,
  // reactive state smuggled through closures or extension-owned refs
  // is not in the render's input set, and the fragment stream doesn't
  // update until an unrelated change (next event) happens to fire
  // the driver. That's the FRP "missing edge" bug class.
  readonly invalidate: Effect.Effect<void>;
  // Ephemeral streaming text deltas from the current inference step.
  // Bounded sliding PubSub (capacity 256) — stalled consumers drop old
  // deltas rather than blocking the inference fiber. Never persisted to
  // the event log; session extensions subscribe here to forward deltas
  // to connected clients in real time.
  readonly textDeltas: Stream.Stream<TextDelta>;
  readonly emitTextDelta: (delta: TextDelta) => Effect.Effect<void>;
}

// Scoped service builder. Each subscription ref update propagates
// through the render fiber. `addTool`/`addAmbient`/`addTransform` are
// implemented via `Effect.acquireRelease` so calling them inside a
// `Layer.scopedDiscard` (the extension idiom) automatically installs a
// matching removal finalizer when the enclosing scope closes.
export const make = (
  opts: AgentCtxOptions,
): Effect.Effect<AgentCtxService, never, import("effect/Scope").Scope> =>
  Effect.gen(function* () {
    const events = yield* makeEventLog(opts.initialEvents ?? []);

    const seedTools = Chunk.fromIterable(opts.initialTools ?? []);
    const tools = yield* SubscriptionRef.make(seedTools);

    const seedSources: Chunk.Chunk<AmbientProducer> = opts.system
      ? Chunk.of<AmbientProducer>({ name: "system", content: opts.system, tag: "core/system" })
      : Chunk.empty<AmbientProducer>();
    const ambients = yield* SubscriptionRef.make(seedSources);
    const cacheAmbient = opts.cacheAmbient ?? true;

    const transforms = yield* SubscriptionRef.make(Chunk.empty<Transform>());
    const errors = yield* SubscriptionRef.make(Chunk.empty<AgentErrorEntry>());
    const emptyContext: ProviderContext = {
      system: "",
      messages: [],
      tools: [],
    };
    const rendered = yield* SubscriptionRef.make<ProviderContext>(emptyContext);
    // Explicit re-render trigger for extension-owned reactive state.
    // Bumped by `invalidate`; merged into the render driver below.
    const invalidateRef = yield* SubscriptionRef.make(0);
    const renderer = opts.renderer;
    const contextFn = opts.context;
    // Default to a placeholder that throws — `createAgentRuntime`
    // overrides this with `runtime.runPromise` once the runtime exists.
    const runEffect =
      opts.runEffect ??
      (<A, E>(_eff: Effect.Effect<A, E, never>): Promise<A> =>
        Promise.reject(
          new Error(
            "AgentCtx.runEffect invoked before the runtime was wired. This indicates the AgentCtx was built without `createAgentRuntime`.",
          ),
        ));
    // Stub matches the `runEffect` placeholder shape: rejects only on
    // invocation so AgentCtx use cases that never touch `ctx.infer`
    // (most tests, ambient-only renders) keep working unchanged.
    const infer: InferFn =
      opts.infer ??
      (() =>
        Promise.reject(
          new Error(
            "AgentCtx.infer invoked but no inferFn was provided. Wire `createAgentRuntime({ infer })` to expose inference to capability components.",
          ),
        ));

    // Per-tool sub-scopes for JSX context tool reconciliation. Keyed by
    // tool name (not reference) — same name across renders = same tool,
    // even if the function identity changed. New tools open a sub-scope
    // and install via `ctx.addTool`; removed tools close their sub-scope
    // so the addTool finalizer releases them; tools present in both
    // renders are left alone.
    const toolScopes = new Map<string, Scope.CloseableScope>();

    const addTool = (tool: Tool): Effect.Effect<void, DuplicateToolError, Scope.Scope> =>
      Effect.acquireRelease(
        SubscriptionRef.modifyEffect(tools, (current) => {
          const exists = Chunk.findFirst(current, (t) => t.name === tool.name);
          if (exists._tag === "Some") {
            return Effect.fail(new DuplicateToolError({ toolName: tool.name }));
          }
          return Effect.succeed([undefined as void, Chunk.append(current, tool)] as const);
        }),
        () =>
          SubscriptionRef.update(tools, (current) =>
            Chunk.filter(current, (t) => t !== tool),
          ),
      );

    const reportError = (phase: string, err: unknown): Effect.Effect<void> =>
      SubscriptionRef.update(errors, (current) =>
        Chunk.append(current, { phase, error: err }),
      );

    // Reconcile JSX-context tools against the previous render's tools.
    // Key by name only — same name = same tool, regardless of function
    // identity. Newly named tools acquire a sub-scope and install via
    // `addTool` extended into that sub-scope; removed names close their
    // sub-scope (the `addTool` finalizer in that scope removes the tool
    // from `ctx.tools`). DuplicateToolError (e.g. tool already registered
    // via `extensions: [...]`) is reported to `ctx.errors` and the
    // sub-scope is closed — the render fiber must not die on it.
    const reconcileContextTools = (
      next: ReadonlyArray<Tool>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const nextByName = new Map<string, Tool>();
        for (const t of next) nextByName.set(t.name, t);
        // Remove dropped tools first so a same-name swap (uncommon but
        // legal) doesn't trip the duplicate guard.
        for (const [name, scope] of toolScopes) {
          if (!nextByName.has(name)) {
            yield* Scope.close(scope, Exit.void);
            toolScopes.delete(name);
          }
        }
        for (const [name, tool] of nextByName) {
          if (toolScopes.has(name)) continue;
          const subScope = yield* Scope.make();
          const installed = yield* Effect.exit(
            addTool(tool).pipe(Scope.extend(subScope)),
          );
          if (Exit.isFailure(installed)) {
            yield* Scope.close(subScope, Exit.void);
            yield* reportError("context", installed.cause);
            continue;
          }
          toolScopes.set(name, subScope);
        }
      });

    // Release every JSX-context tool sub-scope when the agent scope
    // closes. Without this, agent disposal would orphan whatever
    // sub-scopes the last render opened.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        for (const scope of toolScopes.values()) {
          yield* Scope.close(scope, Exit.void);
        }
        toolScopes.clear();
      }),
    );

    // Recompute the materialized ProviderContext from all four inputs.
    // Exposed on the service as `render` so consumers that need
    // a consistent view (most importantly the inference fiber, which
    // would otherwise race the render fiber through `ctx.rendered`)
    // can call it directly.
    //
    // Pipeline order:
    //   1. Synthesized ambient prepend + history seed → Fragment[]
    //   2. Shapers (user-registered transforms) in registration order
    //   3. Terminal adapter transform → ProviderContext
    //
    // The adapter owns auto-cache-breakpoint placement and the
    // alternating-messages invariant; see `render-adapter.ts`.
    const render: Effect.Effect<ProviderContext> = Effect.gen(function* () {
      const currentEvents = yield* events.snapshot;
      const currentSources = yield* SubscriptionRef.get(ambients);
      const currentTransforms = yield* SubscriptionRef.get(transforms);
      const currentTools = yield* SubscriptionRef.get(tools);
      yield* Effect.annotateCurrentSpan({
        "agentctx.render.events.count": Chunk.size(currentEvents),
        "agentctx.render.ambients.count": Chunk.size(currentSources),
        "agentctx.render.transforms.count": Chunk.size(currentTransforms),
        "agentctx.render.tools.count": Chunk.size(currentTools),
      });
      const tctx: TransformContext = {
        tools: Chunk.toReadonlyArray(currentTools),
      };

      // System contributions first, in registration order. For Effect-
      // valued content, materialize within the same render pass so
      // the output stays consistent.
      const systemFragments: Fragment[] = [];
      for (const source of currentSources) {
        const content =
          typeof source.content === "string" ? source.content : yield* source.content;
        const fragment: Fragment = {
          tag: "core/system",
          content,
          source: source.name,
        };
        if (source.cacheControl) fragment.cacheControl = source.cacheControl;
        systemFragments.push(fragment);
      }

      // Default composition: ambient system prefix then event-projected
      // history. Three branches in precedence order:
      //   1. `contextFn` (JSX context): inject events into the render
      //      ambient context, call the user's callback, take the
      //      returned fragments verbatim, and reconcile the returned
      //      tool list against the previous render's tools.
      //   2. `renderer` (legacy hook): hand the composer ambient +
      //      events; it owns the shape.
      //   3. Default: ambient prefix + history projection.
      let fragments: Fragment[];
      if (contextFn) {
        const eventsArr = Chunk.toReadonlyArray(currentEvents);
        // Bridge to JS: the JSX walker is a pure synchronous traversal,
        // so we run it inside Effect.sync after seeding the ambient
        // context. try/finally on the JS side guarantees the external
        // context is cleared even if the user's callback throws — we
        // catch the throw and surface it via reportError so the render
        // fiber stays alive.
        const renderedExit = yield* Effect.sync(() => {
          _setExternalContext({ events: eventsArr, runEffect, infer });
          try {
            return { ok: true as const, value: contextFn() };
          } catch (err) {
            return { ok: false as const, error: err };
          } finally {
            _clearExternalContext();
          }
        });
        let rendered: Rendered;
        if (renderedExit.ok) {
          rendered = renderedExit.value;
        } else {
          yield* reportError("context", renderedExit.error);
          rendered = { fragments: [], tools: [] };
        }
        yield* reconcileContextTools(rendered.tools);
        fragments = [...rendered.fragments];
      } else if (renderer) {
        const eventsArr = Chunk.toReadonlyArray(currentEvents);
        fragments = [...renderer({ events: eventsArr, ambient: systemFragments })];
      } else {
        const historyFragments = renderHistoryFragments(currentEvents);
        fragments = [...systemFragments, ...historyFragments];
      }
      // Apply user-registered shaper transforms in registration order.
      // Composition order is the user's responsibility — the order of
      // `extensions: [...]` in the runtime config determines the order
      // their transforms run here. The convention is ambient-heavy
      // extensions first (fileSystem/shell/skills/mcp), then shapers
      // (snip, truncateTools, truncateToolOutputs, clipMessages).
      for (const t of currentTransforms) {
        fragments = t.run(fragments, tctx);
      }
      // Terminal adapter: Fragment[] → ProviderContext. Owns
      // auto-cache-breakpoint placement and wire-shape invariants.
      return adaptToProviderContext(fragments, tctx, { cacheAmbient });
    }).pipe(Effect.withSpan("agentctx.render"));

    // Merge the change streams from all inputs that affect fragments. The
    // initial emissions of each SubscriptionRef arrive eagerly so the
    // materialized ref is populated before any downstream consumer reads
    // it. mapEffect with concurrency 1 serializes recomputation.
    const driver: Stream.Stream<void> = Stream.merge(
      events.changes,
      Stream.merge(
        ambients.changes,
        Stream.merge(
          transforms.changes,
          Stream.merge(tools.changes, invalidateRef.changes),
        ),
      ),
    ).pipe(
      Stream.mapEffect(() => render, { concurrency: 1 }),
      Stream.changesWith((a, b) => Equal.equals(a, b)),
      Stream.mapEffect((next) => SubscriptionRef.set(rendered, next), { concurrency: 1 }),
    );

    // Run an initial materialization synchronously so the first read of
    // `rendered` reflects seeded state (system fragment + initialEvents +
    // initialTools-projected transforms). Without this, an extension
    // that reads `ctx.rendered.get` before the render fiber has seen
    // its first element would see `Chunk.empty`.
    yield* render.pipe(Effect.flatMap((next) => SubscriptionRef.set(rendered, next)));

    yield* Effect.forkScoped(Stream.runDrain(driver));

    const addAmbient = (source: AmbientProducer): Effect.Effect<void, never, Scope.Scope> =>
      Effect.acquireRelease(
        SubscriptionRef.update(ambients, (current) => Chunk.append(current, source)),
        () =>
          SubscriptionRef.update(ambients, (current) =>
            Chunk.filter(current, (b) => b !== source),
          ),
      );

    const addTransform = (
      transform: Transform,
    ): Effect.Effect<void, never, Scope.Scope> =>
      Effect.acquireRelease(
        SubscriptionRef.update(transforms, (current) => Chunk.append(current, transform)),
        () =>
          SubscriptionRef.update(transforms, (current) =>
            Chunk.filter(current, (t) => t !== transform),
          ),
      );

    const invalidate: Effect.Effect<void> = SubscriptionRef.update(
      invalidateRef,
      (n) => n + 1,
    );

    const deltasHub = yield* PubSub.sliding<TextDelta>(TEXT_DELTA_CAPACITY);
    const textDeltas: Stream.Stream<TextDelta> = Stream.fromPubSub(deltasHub);
    const emitTextDelta = (delta: TextDelta): Effect.Effect<void> =>
      PubSub.publish(deltasHub, delta).pipe(Effect.asVoid);

    const service: AgentCtxService = {
      events,
      tools,
      ambients,
      transforms,
      errors,
      rendered,
      render,
      addTool,
      addAmbient,
      addTransform,
      reportError,
      invalidate,
      textDeltas,
      emitTextDelta,
    };
    return service;
  });

export class AgentCtx extends Effect.Service<AgentCtx>()("@flamecast/agentjsx/AgentCtx", {
  scoped: (opts: AgentCtxOptions) => make(opts),
}) {}
