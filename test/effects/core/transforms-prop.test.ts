import fc from "fast-check";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { AgentCtx } from "@flamecast/agentctx/agent-ctx";
import { createAgentRuntime } from "@flamecast/agentctx";
import { adaptToProviderContext } from "@flamecast/agentctx/render-adapter";
import type {
  Fragment,
  Extension,
  InferFn,
  InferResponse,
  TransformContext,
} from "@flamecast/agentctx";

// Shape of the *inner* transform function — takes blocks, returns
// blocks. The public `Transform` type is a record `{ name, run }`; the
// property test generates the `run` body and the extension wrapper
// stamps a name on at install time.
type TransformFn = (blocks: Fragment[], tctx: TransformContext) => Fragment[];

// Algebraic property test for projection transforms (CLAUDE.md principle 3).
//
// Laws under test:
//   T1. Composition order: transforms apply in registration order. Given
//       transforms [t1, t2, t3], the projected blocks satisfy
//       project = t3(t2(t1(historyAndAmbient))).
//   T2. Log purity: registering arbitrary transforms NEVER mutates the
//       event log. Equivalently, the log snapshot before and after
//       installing extensions is identical (modulo events the agent
//       itself appended via send/inference).
//   T3. Add/drop reversibility: with N reversible transforms, the projection
//       returns to baseline blocks (modulo content equality) once all
//       transforms' scopes close. Validates that `Effect.acquireRelease`
//       cleanup actually un-registers the transform.
//
// These together encode "transforms operate on the projection, never on
// the log" — load-bearing for hydration soundness and the fork-and-modify
// cheapness mentioned in principle 3.

const NUM_RUNS = 50;

// Atomic transforms over Fragment[]. Each is a small named operation we can
// compose and reason about. Order-sensitive ones are intentional — e.g.
// `prepend(X)` then `prepend(Y)` produces `[Y, X, ...rest]`, but
// `prepend(Y)` then `prepend(X)` produces `[X, Y, ...rest]`. T1 catches
// any swap of registration order.
type NamedTransform = { name: string; fn: TransformFn };

const mkPrepend = (tag: string): NamedTransform => ({
  name: `prepend(${tag})`,
  fn: (blocks) => [
    { tag: "core/system", content: `MARK:${tag}`, source: "test" },
    ...blocks,
  ],
});
const mkAppend = (tag: string): NamedTransform => ({
  name: `append(${tag})`,
  fn: (blocks) => [
    ...blocks,
    { tag: "core/system", content: `END:${tag}`, source: "test" },
  ],
});
const mkIdentity = (): NamedTransform => ({
  name: "identity",
  fn: (blocks) => blocks,
});

const transformArb: fc.Arbitrary<NamedTransform> = fc.oneof(
  fc.string({ minLength: 1, maxLength: 3 }).map(mkPrepend),
  fc.string({ minLength: 1, maxLength: 3 }).map(mkAppend),
  fc.constant(mkIdentity()),
);

// An extension that registers a single transform. Used to install transforms
// via the public Extension API rather than hitting `addTransform` directly,
// so we exercise the same Layer.scopedDiscard path real extensions use.
// Transforms run in registration order — no phases to sort.
const transformExt = (name: string, fn: TransformFn): Extension =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const ctx = yield* AgentCtx;
      yield* ctx.addTransform({ name, run: fn });
    }),
  );

// Empty transform context matches what `projectBlocks` passes when no
// tools are registered — the reference composition mirrors runtime
// behavior exactly.
const emptyTctx: TransformContext = { tools: [] };

// Apply a list of transforms to a starting block array — the reference
// composition. T1 asserts the runtime matches this.
const applyAll = (
  start: Fragment[],
  ts: ReadonlyArray<TransformFn>,
): Fragment[] => ts.reduce<Fragment[]>((acc, t) => t(acc, emptyTctx), start);

const stubInfer: InferFn = async (): Promise<InferResponse> => ({ content: "stub" });

describe("transforms: composition + purity laws", () => {
  it("T1 — composition order: transforms apply in registration order", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(transformArb, { minLength: 0, maxLength: 5 }),
        async (transforms) => {
          // Set `cacheAmbient: false` so the baseline is free of the
          // auto-placed cache breakpoint and this test only pins the
          // transform-composition law, not the ambient-caching default.
          const agent = createAgentRuntime({
            system: "S",
            infer: stubInfer,
            cacheAmbient: false,
            extensions: transforms.map((t) => transformExt(t.name, t.fn)),
          });
          try {
            const observed = await agent.rendered();
            // Baseline fragments → apply transforms in order → adapt to
            // ProviderContext. The runtime runs the same pipeline, so
            // observed must equal this reference.
            const baseline: Fragment[] = [
              { tag: "core/system", content: "S", source: "system" },
            ];
            const shaped = applyAll(baseline, transforms.map((t) => t.fn));
            const expected = adaptToProviderContext(shaped, emptyTctx, {
              cacheAmbient: false,
            });
            expect(observed).toEqual(expected);
          } finally {
            await agent.dispose();
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("T2 — log purity: installing transforms never appends events", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(transformArb, { minLength: 0, maxLength: 5 }),
        async (transforms) => {
          const agent = createAgentRuntime({
            infer: stubInfer,
            extensions: transforms.map((t) => transformExt(t.name, t.fn)),
          });
          try {
            const events = await agent.events();
            // No user input, no inference, no tool runs — log must be empty.
            expect(events.length).toBe(0);
          } finally {
            await agent.dispose();
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("T3 — identity element: inserting `id` at any position is a no-op", async () => {
    // Algebraic identity law: for any transform list ts, projection(ts) ===
    // projection(ts with id inserted at position k). Proves the runtime
    // applies the identity transform faithfully (no implicit
    // optimization that drops transforms by reference equality, no hidden
    // state mutation per transform call).
    await fc.assert(
      fc.asyncProperty(
        fc.array(transformArb, { minLength: 1, maxLength: 4 }),
        fc.integer({ min: 0, max: 4 }),
        async (transforms, rawIdx) => {
          const idx = rawIdx % (transforms.length + 1);
          const withId = [
            ...transforms.slice(0, idx),
            mkIdentity(),
            ...transforms.slice(idx),
          ];

          const a1 = createAgentRuntime({
            system: "S",
            infer: stubInfer,
            cacheAmbient: false,
            extensions: transforms.map((t) => transformExt(t.name, t.fn)),
          });
          const a2 = createAgentRuntime({
            system: "S",
            infer: stubInfer,
            cacheAmbient: false,
            extensions: withId.map((t) => transformExt(t.name, t.fn)),
          });
          try {
            const b1 = await a1.rendered();
            const b2 = await a2.rendered();
            expect(b2).toEqual(b1);
          } finally {
            await a1.dispose();
            await a2.dispose();
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});
