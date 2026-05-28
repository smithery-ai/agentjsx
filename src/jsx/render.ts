// Render walker. Traverses a JSX tree, invokes function components,
// and collects framework values (fragments, tools) emitted via the
// sentinel-shaped Elements from `./runtime`.
//
// Intrinsic string-type elements are NOT supported — every component
// in the JSX-context API is a function component. Throwing on
// intrinsics keeps the contract narrow and the failure mode obvious.

import type { Effect } from "effect";
import type { Event, Fragment as RenderedFragment, Rendered, Tool } from "../types";
import {
  type ComponentFunction,
  type Element,
  type Node,
  isEmitElement,
} from "./runtime";

interface RenderCollector {
  fragments: RenderedFragment[];
  tools: Tool[];
}

// RenderContext is the ambient state visible to function components
// during a single render() walk. Components read it via the
// `useRenderContext()` hook. Future fields (errors, gitState, etc.)
// will be added as their consuming components ship.
export interface RenderContext {
  readonly events: ReadonlyArray<Event>;
  // Run an Effect against the agent's ManagedRuntime. Capability
  // components use this to call platform services (FileSystem, Path,
  // CommandExecutor) inside Tool.run callbacks. From the caller's
  // perspective the Effect's `R` channel is `never` — the runtime has
  // already provided the platform layer the user passed via
  // `AgentOptions.platform`. If no platform layer is configured, the
  // Effect can still run; capability components that require platform
  // services will fail at use time with a service-not-found error.
  readonly runEffect: <A, E>(eff: Effect.Effect<A, E, never>) => Promise<A>;
}

// Default runEffect used when render() is invoked outside the agent
// runtime (e.g. ad-hoc tests, examples). Throws on use so it's obvious
// that platform-backed components require the runtime to inject one.
const defaultRunEffect = <A, E>(_eff: Effect.Effect<A, E, never>): Promise<A> => {
  return Promise.reject(
    new Error(
      "runEffect called outside an agent runtime. Wire `createAgentRuntime` with `platform` and render via the agent's `context` callback.",
    ),
  );
};

let currentContext: RenderContext | null = null;
// External context, set by the runtime around a user-supplied
// `context()` callback so a bare `render(tree)` inside that callback
// picks up the runtime's current events/state without the user having
// to thread it through. Cleared in a try/finally by the runtime.
let externalContext: RenderContext | null = null;

// Runtime-internal. Not part of the public API; underscore-prefixed
// to mark "do not call from user code." Exported so `agent-ctx.ts`
// can inject the per-turn render context.
export function _setExternalContext(ctx: RenderContext): void {
  externalContext = ctx;
}

export function _clearExternalContext(): void {
  externalContext = null;
}

export function useRenderContext(): RenderContext {
  if (currentContext === null) {
    throw new Error("useRenderContext called outside a render() walk");
  }
  return currentContext;
}

export function render(root: Node, context?: RenderContext): Rendered {
  const collector: RenderCollector = { fragments: [], tools: [] };
  const previous = currentContext;
  // Precedence: explicit `context` arg wins (callers that thread their
  // own state stay in control), otherwise pick up the runtime-injected
  // external context, otherwise default to an empty events context.
  currentContext =
    context ??
    externalContext ?? { events: [], runEffect: defaultRunEffect };
  try {
    walk(root, collector);
  } finally {
    currentContext = previous;
  }
  return { fragments: collector.fragments, tools: collector.tools };
}

// Walk a child subtree into a fresh local collector and return the
// captured Rendered. Used by wrapping components (e.g. <Compact>) that
// need to inspect what their children would have emitted, transform it,
// and re-emit a derived value to the outer collector.
//
// Emits captured here do NOT bubble to the outer walker — that's the
// whole point. The wrapping component decides what (if anything) to
// emit into the outer collector via emitFragment/emitTool on its own
// return value. The ambient RenderContext (events, runEffect) is the
// same one the outer walker is using; useRenderContext() inside the
// children works exactly as before.
//
// Nesting is safe: each renderChildren call has its own collector
// variable. There's no module-level collector "stack" to manage because
// the existing walker already takes its collector as an explicit
// argument — see walk() below.
export function renderChildren(children: Node | ReadonlyArray<Node>): Rendered {
  const collector: RenderCollector = { fragments: [], tools: [] };
  // Array case is just a Node per the Node union; walk handles both.
  walk(children as Node, collector);
  return { fragments: collector.fragments, tools: collector.tools };
}

function walk(node: Node, collector: RenderCollector): void {
  if (node === null || node === undefined || typeof node === "boolean") {
    return;
  }
  if (typeof node === "string" || typeof node === "number") {
    // Text nodes don't emit anything in this MVP — components convert
    // their text children into fragments explicitly via emitFragment.
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, collector);
    return;
  }
  const element = node as Element;
  if (isEmitElement(element)) {
    const kind = element.props.__emit;
    const value = element.props.value;
    if (kind === "fragment") {
      collector.fragments.push(value as RenderedFragment);
    } else if (kind === "tool") {
      collector.tools.push(value as Tool);
    }
    return;
  }
  if (typeof element.type === "string") {
    throw new Error(
      `Intrinsic elements not supported; use function components (got <${element.type}>)`,
    );
  }
  if (typeof element.type !== "function") {
    throw new Error("Unknown element type in render walk");
  }
  // Call the function component with props + children injected. The
  // returned Node is recursed on — components emit by returning
  // sentinel Elements (or arrays/Fragments containing them).
  const component = element.type as ComponentFunction;
  const propsWithChildren: Record<string, unknown> = {
    ...element.props,
    children: element.children,
  };
  const result = component(propsWithChildren);
  walk(result, collector);
}
