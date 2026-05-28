import { Chunk, Effect, Layer, Schema, Scope, SubscriptionRef } from "effect";
import { AgentCtx } from "../core/agent-ctx";
import type { Extension } from "../core/agent";
import type { Event, ProviderContext, Tool, InferFn } from "../core/types";
import { inProcessBackend } from "./in-process-backend";
import { registerTool } from "./tool-registration";

// Terminal shape mirrored from `smithery/terminal.ts`. Kept aligned
// with the signals copy at signals/extensions/subagents.ts — update
// both sites if either moves.
export type SubagentTerminal =
  | { kind: "result"; text: string }
  | { kind: "halted"; reason: string }
  | { kind: "error"; message: string };

// What the extension hands to a backend when the parent invokes
// `spawn_agent`. `agentType` is a free-form label — the catalog name
// in catalog mode, the string `"freeform"` when spawned via systemPrompt.
// Backends should not key on it beyond logging/reportError phases.
export interface SubagentSpawnOpts {
  parentHandle: string;
  agentType: string;
  systemPrompt?: string;
  model?: string;
  extensions: Extension[];
  initialEvents: Event[];
  tools: Tool[];
  prompt: string;
  sharedBlocks: Record<string, () => string>;
}

// Pluggable spawn strategy. Backends that want to run children out-of-
// process (remote worker, Docker, MCP server) implement this contract;
// the default `inProcessBackend` runs children in the same isolate.
export interface SubagentBackend {
  spawn(opts: SubagentSpawnOpts): Promise<{ handle: string }>;
  wait(handle: string): Promise<SubagentTerminal>;
  status(handle: string): Promise<"running" | "done" | "failed">;
  abort(handle: string, reason?: string): Promise<void>;
}

// A named preset agent. Callers curate these when they want the parent
// model to pick from a typed menu of specialist personas with
// pre-configured extensions and shared-state hooks.
export interface SubagentDef {
  description: string;
  extensions: () => Extension[];
  model?: string;
  systemPrompt?: string;
  sharedBlocks?: (input: {
    parentEvents: () => Event[];
    // Parent's current ProviderContext — the same shape the parent's
    // `infer` sees. Useful for deriving child state from the parent's
    // final render output without re-traversing the event log.
    parentRendered: () => ProviderContext;
    toolArgs: Record<string, unknown>;
  }) => Record<string, () => string>;
}

export interface SubagentsOptions {
  // Named preset catalog. When provided with at least one entry, the
  // model can call `spawn_agent({ type, prompt })` to instantiate one.
  // Optional — omit when the parent should only spawn freeform subagents.
  agents?: Record<string, SubagentDef>;
  // Freeform defaults. Applied when the tool call omits `type` — the
  // parent describes the child inline via `systemPrompt` + `prompt`
  // and the child runs with these extensions. Omit to disable freeform
  // mode (then `type` becomes required, and a tool call without it
  // returns a tool-level error).
  defaultExtensions?: () => Extension[];
  defaultSystemPrompt?: string;
  defaultModel?: string;
  // Explicit backend override. When absent, `infer` is required and
  // the default in-process backend is built from it.
  backend?: SubagentBackend;
  infer?: InferFn;
  toolName?: string;
  // "deny" (default): child never has access to its own spawn_agent
  // tool — recursion is impossible. "allow" + maxDepth>1: re-install
  // this extension on children with decremented depth; when maxDepth
  // reaches 1, the next-level child has no spawn_agent tool and any
  // attempt fails at the tool dispatcher with an unknown-tool error.
  recursion?: "deny" | "allow";
  maxDepth?: number;
}

export { inProcessBackend };

// Registers a `spawn_agent` tool the parent can use to launch a child.
// Two modes, both supported in one call:
//
//  1. **Catalog**: pass `agents: { researcher: { description, extensions, ... } }`.
//     Tool call shape: `{ type: "researcher", prompt: "..." }`. The
//     child inherits the named def's extensions, systemPrompt, and
//     any `sharedBlocks` binding against live parent state.
//
//  2. **Freeform**: pass `defaultExtensions: () => [...]`. Tool call
//     shape: `{ prompt: "...", systemPrompt?: "...", model?: "..." }`
//     (no `type`). The parent describes the child's behavior inline.
//     The child runs with `defaultExtensions()`.
//
// Both modes can coexist — when both are configured, `type` is optional:
// if present and matches a catalog entry, catalog wins; if absent, the
// call is freeform. When only catalog is configured, `type` is required
// and a freeform call returns a tool-level error. When only freeform is
// configured, `type` is rejected if supplied.
//
// Child scope is bounded by the parent's extension scope — on parent
// disposal every live child is aborted via `backend.abort`.
export const subagents = (opts: SubagentsOptions): Extension => {
  const {
    agents,
    defaultExtensions,
    defaultSystemPrompt,
    defaultModel,
    backend: providedBackend,
    infer,
    toolName = "spawn_agent",
    recursion = "deny",
    maxDepth = 1,
  } = opts;

  const agentNames = agents ? Object.keys(agents) : [];
  const hasCatalog = agentNames.length > 0;
  const hasFreeform = defaultExtensions !== undefined;

  if (!hasCatalog && !hasFreeform) {
    throw new Error(
      "subagents(): provide `agents` (catalog) or `defaultExtensions` (freeform), or both.",
    );
  }

  let backend: SubagentBackend;
  if (providedBackend) {
    backend = providedBackend;
  } else if (infer) {
    backend = inProcessBackend(infer);
  } else {
    throw new Error(
      "subagents(): provide either `backend` or `infer`. The default in-process backend needs an `infer` fn.",
    );
  }

  const menu = hasCatalog
    ? agentNames
        .map((name) => `  - ${name}: ${agents![name].description}`)
        .join("\n")
    : "";
  const catalogDesc = hasCatalog ? `\nAvailable preset types:\n${menu}` : "";
  const freeformDesc = hasFreeform
    ? "\nOr omit `type` and pass `systemPrompt` + `prompt` to spawn a freeform child."
    : "";
  const description = `Spawn a subagent to handle a focused subtask. Each subagent runs in a fresh context window and returns only its final message.${catalogDesc}${freeformDesc}`;

  // Parameters schema — `type` and `systemPrompt` are both optional at
  // the schema level; the runtime enforces the mode-specific rules and
  // returns friendly tool-level errors. Keeps the JSON schema compact
  // while letting the model use whichever mode is available.
  const parameters = Schema.Struct({
    type: Schema.String.annotations({
      description: hasCatalog
        ? `Preset type to spawn. Optional when freeform is available.`
        : `Not supported in this configuration — freeform only.`,
      ...(hasCatalog
        ? { jsonSchema: { type: "string", enum: agentNames } }
        : {}),
    }).pipe(Schema.optionalWith({ nullable: true })),
    systemPrompt: Schema.String.annotations({
      description:
        "Freeform mode: describe the child's role and constraints. Ignored when `type` references a preset.",
    }).pipe(Schema.optionalWith({ nullable: true })),
    prompt: Schema.String.annotations({
      description: "The task for the subagent.",
    }),
    model: Schema.String.annotations({
      description:
        "Freeform mode: optional model override. Custom backends may key on this; the default in-process backend ignores it.",
    }).pipe(Schema.optionalWith({ nullable: true })),
  });

  return Layer.scopedDiscard(
    Effect.gen(function* () {
      const ctx = yield* AgentCtx;
      const parentScope = yield* Effect.scope;
      const liveHandles = new Set<string>();
      yield* Scope.addFinalizer(
        parentScope,
        Effect.sync(() => {
          for (const h of liveHandles) {
            void backend.abort(h).catch(() => {});
          }
          liveHandles.clear();
        }),
      );

      yield* registerTool(ctx, "subagents", {
        name: toolName,
        description,
        parameters,
        run: async (args) => {
          const typeArg = args.type;
          // Empty string is treated as "no type" — the model probably
          // meant to omit it. Consistent with null/undefined routing.
          const useCatalog =
            typeArg !== undefined && typeArg !== null && typeArg !== "";

          if (useCatalog) {
            if (!hasCatalog) {
              return `Error: \`type\` is not supported — this subagents() was configured for freeform only. Omit \`type\` and pass \`systemPrompt\` instead.`;
            }
            const def = agents![typeArg];
            if (!def) {
              return `Error: Unknown subagent type: ${typeArg}. Available: ${agentNames.join(", ")}`;
            }
            return spawnCatalog({
              ctx,
              def,
              typeArg,
              args,
              backend,
              liveHandles,
              childExtensionsBase: () => [...def.extensions()],
              recursion,
              maxDepth,
              opts: {
                agents,
                ...(defaultExtensions ? { defaultExtensions } : {}),
                ...(defaultSystemPrompt ? { defaultSystemPrompt } : {}),
                ...(defaultModel ? { defaultModel } : {}),
                ...(providedBackend ? { backend: providedBackend } : {}),
                ...(infer ? { infer } : {}),
                toolName,
              },
            });
          }

          if (!hasFreeform) {
            return `Error: \`type\` is required — this subagents() was configured for catalog only. Available: ${agentNames.join(", ")}`;
          }
          return spawnFreeform({
            ctx,
            args,
            backend,
            liveHandles,
            defaultExtensions: defaultExtensions!,
            ...(defaultSystemPrompt ? { defaultSystemPrompt } : {}),
            ...(defaultModel ? { defaultModel } : {}),
            recursion,
            maxDepth,
            opts: {
              ...(agents ? { agents } : {}),
              defaultExtensions: defaultExtensions!,
              ...(defaultSystemPrompt ? { defaultSystemPrompt } : {}),
              ...(defaultModel ? { defaultModel } : {}),
              ...(providedBackend ? { backend: providedBackend } : {}),
              ...(infer ? { infer } : {}),
              toolName,
            },
          });
        },
      });
    }),
  );
};

// Catalog-mode spawn: look up def, pre-bind sharedBlocks, optionally
// re-install subagents() on the child for controlled recursion.
async function spawnCatalog(p: {
  ctx: AgentCtx;
  def: SubagentDef;
  typeArg: string;
  args: { prompt: string; systemPrompt?: string | undefined; model?: string | undefined };
  backend: SubagentBackend;
  liveHandles: Set<string>;
  childExtensionsBase: () => Extension[];
  recursion: "deny" | "allow";
  maxDepth: number;
  opts: Omit<SubagentsOptions, "recursion" | "maxDepth">;
}): Promise<string> {
  const { ctx, def, typeArg, args, backend, liveHandles, recursion, maxDepth } = p;
  const childExtensions: Extension[] = p.childExtensionsBase();

  let boundSharedBlocks: Record<string, () => string> = {};
  if (def.sharedBlocks) {
    const parentEventsFn = (): Event[] => {
      const snap = Effect.runSync(ctx.events.snapshot);
      return Chunk.toReadonlyArray(snap).slice();
    };
    const parentRenderedFn = (): ProviderContext =>
      Effect.runSync(SubscriptionRef.get(ctx.rendered));
    boundSharedBlocks = def.sharedBlocks({
      parentEvents: parentEventsFn,
      parentRendered: parentRenderedFn,
      toolArgs: args as unknown as Record<string, unknown>,
    });
  }

  if (recursion === "allow" && maxDepth > 1) {
    childExtensions.push(
      subagents({
        ...p.opts,
        recursion: "allow",
        maxDepth: maxDepth - 1,
      }),
    );
  }

  const spawnOpts: SubagentSpawnOpts = {
    parentHandle: "root",
    agentType: typeArg,
    ...(def.systemPrompt ? { systemPrompt: def.systemPrompt } : {}),
    ...(def.model ? { model: def.model } : {}),
    extensions: childExtensions,
    initialEvents: [],
    tools: [],
    prompt: args.prompt,
    sharedBlocks: boundSharedBlocks,
  };

  return runSpawn(ctx, backend, liveHandles, typeArg, spawnOpts);
}

async function spawnFreeform(p: {
  ctx: AgentCtx;
  args: { prompt: string; systemPrompt?: string | undefined; model?: string | undefined };
  backend: SubagentBackend;
  liveHandles: Set<string>;
  defaultExtensions: () => Extension[];
  defaultSystemPrompt?: string;
  defaultModel?: string;
  recursion: "deny" | "allow";
  maxDepth: number;
  opts: SubagentsOptions;
}): Promise<string> {
  const {
    ctx,
    args,
    backend,
    liveHandles,
    defaultExtensions,
    defaultSystemPrompt,
    defaultModel,
    recursion,
    maxDepth,
  } = p;
  const childExtensions: Extension[] = [...defaultExtensions()];

  if (recursion === "allow" && maxDepth > 1) {
    childExtensions.push(
      subagents({
        ...p.opts,
        recursion: "allow",
        maxDepth: maxDepth - 1,
      }),
    );
  }

  const systemPrompt = args.systemPrompt ?? defaultSystemPrompt;
  const model = args.model ?? defaultModel;

  const spawnOpts: SubagentSpawnOpts = {
    parentHandle: "root",
    agentType: "freeform",
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(model ? { model } : {}),
    extensions: childExtensions,
    initialEvents: [],
    tools: [],
    prompt: args.prompt,
    sharedBlocks: {},
  };

  return runSpawn(ctx, backend, liveHandles, "freeform", spawnOpts);
}

async function runSpawn(
  ctx: AgentCtx,
  backend: SubagentBackend,
  liveHandles: Set<string>,
  phaseLabel: string,
  spawnOpts: SubagentSpawnOpts,
): Promise<string> {
  let handle: string;
  try {
    const spawned = await backend.spawn(spawnOpts);
    handle = spawned.handle;
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    await Effect.runPromise(ctx.reportError(`subagent:${phaseLabel}`, e));
    return `Subagent failed: ${e.message}`;
  }

  liveHandles.add(handle);
  try {
    const terminal = await backend.wait(handle);
    if (terminal.kind === "result") return terminal.text;
    if (terminal.kind === "halted") {
      return `Subagent halted: ${terminal.reason}`;
    }
    await Effect.runPromise(
      ctx.reportError(`subagent:${phaseLabel}`, new Error(terminal.message)),
    );
    return `Subagent failed: ${terminal.message}`;
  } finally {
    liveHandles.delete(handle);
  }
}
