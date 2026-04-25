# Harness agentctx runtime — design principles

This directory holds the Effect-TS agent runtime. Everything here follows six principles, discovered during PRs #156–#163. When adding or modifying code, follow them. When a change feels awkward, the principles are probably why — surface the mismatch before coding.

## 1. Log is the source of truth

Every side effect produces an event. `ctx.events` (`SubscriptionRef<Chunk<Event>>`) is the agent's memory; state not reachable from it is second-class.

- User said something → `user.message` event.
- Tool ran → `tool.result` event (preceded by `tool.call.started` beacon).
- Agent replied → `assistant.message` event.
- Context compacted → `compaction.summary` event.
- Agent stopped → `assistant.halted` event.

**Why**: hydration is free (replay the log, get the same state), debugging is free (dump the log, see what happened), consistency across fibers is free (everyone reads the same append-only stream).

**Apply**: before adding a new extension that holds state, ask — can this be an event instead? If yes, add the event type in `types.ts` and project it appropriately. Closure state and `Ref`s are valid, but they're an escape hatch, not the default.

## 2. Extensions are small, focused, composable

Each extension does one thing. A dozen small extensions beat one big one.

Current surface:
- `workspace` bundles `shell` + `fileSystem` at one root — but `shell` and `fileSystem` are independent and usable alone.
- `recall` exposes log-reading; `truncateToolOutputs` rewrites projection; they compose but work independently.
- `compact` and `summarize` share the `compaction.summary` event type but trigger differently (model-driven vs threshold-driven).

**Why**: small extensions mean users can opt in to exactly what they want. Combining two is the common case. Fork-and-modify is cheap because the surface is narrow.

**Apply**: resist the urge to bundle. When two features feel like they belong together, ask if they *must* be, or if they're just *often* used together. Usually the latter — expose each independently and let composition emerge.

## 3. Transforms operate on the projection, never mutate the log

The log is append-only. View shaping happens at render time via `ctx.addTransform({ name, run })`. User-registered transforms are shapers over `Fragment[]` — they run between the seed (ambient + history) and the terminal adapter, which folds the final `Fragment[]` into the provider-ready `ProviderContext` (`{ system, messages, tools }`) that `ctx.render` / `ctx.rendered` expose and `infer` receives. The adapter lives in `render-adapter.ts`; it owns the alternating-messages invariant and the auto-cache-breakpoint contract. Every transform carries a name (surfaced in diagnostics) and a `run` function.

Transforms run in registration order — the order each extension calls `addTransform` determines the order transforms apply at render time. Across extensions, order is the order of the `extensions: [...]` array in the runtime config. Composition order is the operator's responsibility; there are no named phases and no implicit sorting. The conventional stack order is ambient-heavy extensions first (fileSystem, shell, skills, mcp), then shapers (snip, truncateTools, truncateToolOutputs, clipMessages), then any provider-specific finalize-equivalents last — but the runtime enforces nothing beyond "run them in the order you registered them."

Roles of the built-in transforms (all run in registration order, no special sort):

- `snip` — reorder/drop blocks while keeping the projection provider-valid. Drops the oldest history blocks and leaves a marker.
- `truncateTools` — rewrite tool-result block content. Clears stale tool-result bodies.
- `truncateToolOutputs` — replaces oversized tool outputs with previews.
- `clipMessages` — generic per-block content cap.

`run` receives `(blocks, tctx)`, where `tctx` carries pre-resolved framework state (`tctx.tools`, currently). The projection driver subscribes to the underlying refs, so transforms re-run with fresh `tctx` on any relevant change. Never reach into `ctx.tools` / `SubscriptionRef` primitives from inside a transform body — that creates a throwaway Effect runtime and hides the dependency from the projection driver.

`summarize`'s `compaction.summary` events are projected by `renderHistoryFragments` — the log is never rewritten; the projection collapses ranges at render time.

**Why**: reversibility (drop a transform, full history returns), hydration soundness (log is the same whether transforms are loaded or not), multiple views (the same log can render differently for different consumers). Registration-order composition keeps the runtime's transform model dead simple — `extensions: [...]` fully determines what runs when, and reordering is a single-edit operation for the operator.

**Apply**: when tempted to "clean up" the log, don't. Write a transform that hides/rewrites in the projection. Place the extension in `extensions: [...]` at the position where its transform should run relative to other transforms. See `src/extensions/truncate-tool-outputs.ts` for the canonical shape including `tctx` usage.

## 4. Tools are pure functions that declare events

`tool.run` returns data, not state. The framework (tool-exec) performs the writes.

```ts
type ToolOutcome =
  | string                                              // shorthand for { content }
  | { content: string; extraEvents?: EventInput[] };    // declare extra appends
```

Tool body computes and returns. tool-exec appends `extraEvents` first, then `tool.result`, atomically. See `.kindling/tool-outcome-with-events.md` for the design history.

**Why**: single writer to the log keeps everything ordered. Tool authors don't need to know about Effect runtimes, SubscriptionRefs, cross-runtime hazards. The compact tool is the canonical example: pure function in, structural event out.

**Apply**: if a tool needs to change agent state beyond its `tool.result`, return `{ content, extraEvents: [...] }`. Never `Effect.runPromise(ctx.events.append(...))` inside a tool body — that creates a throwaway runtime and breaks live subscriptions (see `.kindling/tool-outcome-with-events.md` for the story).

## 5. State lives in Effect primitives; closure state is suspect

Mutable closure variables shared between fibers cause glitches (see CLAUDE.md at repo root for the FRP glitch rule). The rule: state that's read from a fiber also subscribed to the producing stream must come from `SubscriptionRef` via `render`-shaped primary-source derivations, not from a materialized ref another fiber maintains.

- `ctx.events` — events.
- `ctx.tools`, `ctx.ambients`, `ctx.transforms`, `ctx.errors` — all `SubscriptionRef`s.
- `ctx.invalidate` — explicit reprojection trigger for extension-owned reactive state outside the standard inputs.
- `ctx.rendered` — materialized projection; **only** read by single-observation consumers (UI, `until` predicates, tests). Never by fibers also subscribed to `log.changes`.

**Why**: race-free concurrency. Two fibers reading stale-vs-fresh state is the classical FRP glitch. We hit it once (fixed in #157); we've encoded "no second-hand derived state across fibers" as a repo-wide rule.

**Apply**: when forking a fiber (`Effect.forkScoped`), list what streams it subscribes to. List what refs it reads. Any overlap = potential race. Use `ctx.render` or equivalent primary-source derivation, not `ctx.rendered`.

## 6. Extensions are atomic or composed — never coupled via adaptation for behavior

Every extension is usable alone. When two extensions must coordinate for *behavior*, you do not add a branch that probes for the other — you compose them in a named module. The field at large (ZIO/Effect explicit Layer deps, Babel presets, Tower's typed composition, Hapi/Fastify dependency declarations, Bevy's migration away from `is_plugin_added`) reached consensus years ago: adaptation for semantic behavior is a trap. It creates an implicit 2^N test matrix, hides coupling from the type system, and turns every rename or removal elsewhere in the tree into a silent regression here.

**Two legal shapes:**

- **Atomic extension.** One concern, zero assumptions about siblings. Reads only its own config plus the universally-present `ctx` surface (`ctx.events`, `ctx.tools` for its *own* registration, etc.). Behavior is a pure function of inputs.
- **Composed extension.** When two atoms must ship together to produce a combined behavior, create a composition in `extensions/composed/` (or its natural home) that installs both and owns the glue. The composition's name IS the coupling's name — it becomes a reviewable, testable unit instead of a hidden probe.

`workspace` = `shell` + `fileSystem` is the canonical composition shape.

**The narrow annotation-only exception.**

An atomic extension MAY probe `ctx.tools` / `ctx.ambients` to refine a *user-facing message* — never to change what the extension produces or contributes. The probe is allowed only when all four hold:

1. **Single-point.** One read, at projection/registration time, not scattered through the code.
2. **Annotation-only.** The probe changes a string the LLM sees, not a behavior it observes. Remove the extension that was probed — the core behavior of the probing extension is identical.
3. **Absence is a valid operational mode.** The "without sibling" message must be correct and actionable on its own, not a degraded stub that points to capabilities the loadout doesn't have.
4. **No chain.** The probed extension doesn't itself probe further. Chains of soft-detection are how systems unravel at scale.

Canonical example: `truncateToolOutputs` probes for `recall` to decide whether the truncation pointer says `recall({seqs:[N]})` (direct recovery) or "re-run with narrower args / spawn a subagent" (universal fallback). The truncation itself happens identically either way. Both messages are correct in their respective loadouts. This is the LLVM `getCachedResult<>()` pattern — "use a cached analysis if it's there, otherwise produce a valid answer without it" — which every mature system converged on as the narrow legal hatch.

**What the exception is NOT.**

- Not a license for "I check if X exists and change what I do." If the probe gates behavior rather than messaging, you've crossed the line — compose.
- Not a chain of probes. If `A` probes `B` and `B` probes `C`, you have a distributed state machine with no home. Collapse into a composition.
- Not an escape valve for skipping design work. "It's only a message" is a lossy summary when the message teaches the model how to recover from a failure mode. Ask: if I deleted the probed extension tomorrow, is the un-branched message still good enough for an operator to debug from? If no, the coupling is behavioral — compose.

**Event contracts are a separate case.**

Two extensions may both emit or consume an event type (`compaction.summary` is emitted by `compact` and `summarize`; consumed by the projection and hidden by `recall`). This is not adaptation — neither extension probes for the other. It's a shared log contract. Document the contract on the event type's definition in `types.ts` so the producers/consumers are discoverable without reading every extension. If the contract demands that both producers be installed together, compose them.

**Why**: extensions stay usable alone. Coupling, where genuine, is named and co-located with its glue. The compile-time extension count matches the runtime behavior surface. Removing an extension has a predictable, local blast radius: at most, a composition breaks — never a hidden branch in an unrelated file.

**Apply**: before reaching for `ctx.tools` inside an extension, answer these in order:
1. "Am I changing behavior or annotating a message?" If behavior → compose.
2. "Is the un-probed path correct and operationally useful?" If no → compose.
3. "Have I passed the four-point test above?" If no → compose.
4. "Could I delete the probe tomorrow without regressing the LLM's debugging path?" If yes, you might not even want the probe. Prefer the simpler path.

Never import another extension's internals. Never chain probes. Never probe to decide *whether* to do something — only to decide *how* to describe something you're doing anyway.

## Decision checklist for a new extension

Before writing code:

1. **What state does this need?** If it's log-shaped (events), add an event type. If it's extension-local (e.g. a rate-limit budget), use `Ref`. Never read another extension's private state.
2. **What does it contribute?** Tools (`ctx.addTool`), ambient fragments (`ctx.addAmbient`), transforms (`ctx.addTransform`), fibers (`Effect.forkScoped`). One extension usually contributes 1–2 of these. If it's a transform: where does it sit in the transform pipeline? Registration order determines run order (see principle 3), so the extension's position in `extensions: [...]` is load-bearing — document what it expects to run before/after.
3. **Is there a fiber watching a stream?** If yes, walk the "no second-hand derived state" check from principle 5.
4. **Does a tool need to write events?** Use `ToolOutcome` with `extraEvents`. Never `Effect.runPromise` from tool.run into reactive state.
5. **Does this need behavior from another extension?** Compose them — create a named module in `extensions/composed/` (or the natural home) that installs both and owns the glue. Do not reach for a `ctx.tools` probe to gate behavior. Annotation-only probes are a narrow exception; see principle 6.
6. **Is it really small?** If the extension is > ~200 LOC, check whether it's actually two extensions.

## Anti-patterns

- **Mutable closure variables read by forked fibers that subscribe to the same upstream stream as the writer fiber.** FRP glitch. See #157, regression test at `test/agentctx/core/inference-consistency*.test.ts`.
- **`Effect.runPromise(ctx.events.append(...))` inside `tool.run`.** Cross-runtime write that breaks live subscriptions. Use `ToolOutcome.extraEvents` instead.
- **Bundling multiple concerns into one extension.** If you're passing 5+ options to control which sub-behavior is active, it's really 5 extensions.
- **Importing from another extension's `src/extensions/<name>.ts`.** Hard coupling. Compose in a named module instead.
- **Probing `ctx.tools` to gate behavior rather than annotate a message.** See principle 6 — annotation-only is the narrow legal hatch; anything that changes what an extension *does* based on another extension's presence must be a composition.
- **Emitting events not defined in `types.ts`.** All event types are centralized so hydration, projection, and tool-exec handle them consistently.
- **Forking fibers without `Effect.forkScoped`.** Unscoped fibers don't die on agent dispose; they leak.
- **Writing to `ctx.rendered` from anywhere other than the projection fiber.** `ctx.rendered` is the materialized output; only the projection driver writes to it.

## Canonical references

- Event-sourced algebra + hydration: `src/projections.ts`, `src/hydration.ts`.
- Tool writes via ToolOutcome: `src/tool-exec.ts` (see `normalizeOutcome`), example in `src/extensions/auto-compact.ts`.
- FRP-safe projection: `src/agent-ctx.ts` (`render`).
- Annotation-only probe (narrow exception): `src/extensions/truncate-tool-outputs.ts` reads `ctx.tools` at transform time to choose between a direct `recall` pointer and a universal subagent/re-run hint. The truncation itself happens identically either way.
- Canonical composition: `src/extensions/workspace.ts` (= `shell` + `fileSystem` + glue). The right shape when two extensions must ship together.
- Small composable extension shape: `src/extensions/recall.ts` (one tool, no state, no fibers).
- Extension that forks a fiber correctly: `src/extensions/summarize.ts` (subscribes to `ctx.rendered.changes`, writes via `yield* ctx.events.append`).

## Design doc graveyard

Reasoning behind non-obvious decisions lives in `.kindling/`:
- `tool-outcome-with-events.md` — why `ToolOutcome` ≠ a `ctx.run` bridge.
- `jsx-context-rendering.md` — why JSX owns context shape only.
- `fibers-resilience.md` — durable tool events, intent beacons.
- `frp-glitch-multi-subscriber-race.md` (in `~/.claude/skills/gotchas/`) — the FRP glitch we hit and how we fixed it.

When in doubt, read the kindling entry; it has the rejected alternatives with reasons.
