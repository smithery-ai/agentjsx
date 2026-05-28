// Render walker. Traverses a JSX tree, invokes function components,
// and collects framework values (fragments, tools) emitted via the
// sentinel-shaped Elements from `./runtime`.
//
// Intrinsic string-type elements are NOT supported — every component
// in the JSX-context API is a function component. Throwing on
// intrinsics keeps the contract narrow and the failure mode obvious.

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
}

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
  currentContext = context ?? externalContext ?? { events: [] };
  try {
    walk(root, collector);
  } finally {
    currentContext = previous;
  }
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
