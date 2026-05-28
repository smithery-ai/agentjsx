// JSX runtime — pure types + factory. No React, no Effect.
//
// Classic JSX mode: tsconfig has `jsxFactory: "createElement"` and
// `jsxFragmentFactory: "Fragment"`. Library files in `src/jsx/*.tsx`
// import these symbols explicitly.
//
// Components are pure functions from props → Node. They are NEVER
// called inside `createElement` — the render walk (see `./render.ts`)
// invokes them with their props (with `children` injected) and recurses
// on the returned Node.
//
// To emit framework values (Fragments, Tools) from a component body,
// return a sentinel-shaped Element produced by `emitFragment` /
// `emitTool`. The walker recognizes the shape and pushes into the
// collector instead of treating the value as a child.

import type { Fragment as RenderedFragment, Tool } from "../core/types";

export type ComponentFunction = (props: Record<string, unknown>) => Node;

export type ElementType = string | ComponentFunction;

export interface Element {
  readonly type: ElementType;
  readonly props: Record<string, unknown>;
  readonly children: ReadonlyArray<Node>;
}

export type Node =
  | Element
  | string
  | number
  | null
  | undefined
  | boolean
  | ReadonlyArray<Node>;

// Fragment is a function component that returns its children unchanged.
// Standard React-style behavior — the walker treats the returned array
// as a list of Nodes to recurse on.
export const Fragment: ComponentFunction = (props) => {
  const children = props["children"];
  if (Array.isArray(children)) return children as ReadonlyArray<Node>;
  if (children === undefined) return [];
  return [children as Node];
};

export function createElement(
  type: ElementType,
  props: Record<string, unknown> | null,
  ...children: Node[]
): Element {
  const normalizedProps: Record<string, unknown> = props === null ? {} : { ...props };
  const propsChildren = normalizedProps["children"];
  // Variadic children take precedence; if a `children` prop was also
  // supplied, concat them. JSX spread doesn't put children in props, so
  // this only fires for explicit `children={...}` usage.
  let allChildren: ReadonlyArray<Node>;
  if (propsChildren === undefined) {
    allChildren = children;
  } else {
    const extra = Array.isArray(propsChildren)
      ? (propsChildren as ReadonlyArray<Node>)
      : [propsChildren as Node];
    allChildren = [...children, ...extra];
  }
  // Drop `children` from props — children are tracked on the Element
  // directly and re-injected into props when the walker calls a
  // function component.
  delete normalizedProps["children"];
  return { type, props: normalizedProps, children: allChildren };
}

// Sentinel shape for emitted framework values. The walker recognizes
// `type === EMIT_SENTINEL` and reads `props.__emit` / `props.value`.
// Modeled as an Element so the JSX tree stays homogeneous.
export const EMIT_SENTINEL: ComponentFunction = () => null;

// Commands are user-initiated: the operator types `/<name> <args>` into
// `agent.run` and the runtime dispatches to a registered handler. They
// differ from tools (model-initiated) and fragments (declarative prompt
// content). A handler may register halt predicates imperatively via its
// CommandRuntime; halt predicates are not emit values themselves because
// the runtime owns their lifecycle, not the JSX walk.
export interface Command {
  readonly name: string;
  readonly description?: string;
  readonly handler: CommandHandler;
}

export type CommandHandler = (ctx: {
  readonly args: string;
  readonly runtime: CommandRuntime;
}) => Promise<void> | void;

export interface CommandRuntime {
  appendUserMessage: (text: string) => void;
  registerHaltPredicate: (name: string, fn: HaltPredicate) => void;
  clearHaltPredicate: (name: string) => void;
}

export type HaltPredicate = (ctx: {
  readonly events: ReadonlyArray<import("../core/types").Event>;
  readonly infer: import("../core/types").InferFn;
}) => Promise<{ ok: boolean; reason: string }>;

export type EmitKind = "fragment" | "tool" | "command";

export interface EmitElement extends Element {
  readonly type: typeof EMIT_SENTINEL;
  readonly props: {
    readonly __emit: EmitKind;
    readonly value: RenderedFragment | Tool | Command;
  };
}

export function emitFragment(value: RenderedFragment): EmitElement {
  return {
    type: EMIT_SENTINEL,
    props: { __emit: "fragment", value },
    children: [],
  };
}

export function emitTool(value: Tool): EmitElement {
  return {
    type: EMIT_SENTINEL,
    props: { __emit: "tool", value },
    children: [],
  };
}

export function emitCommand(value: Command): EmitElement {
  return {
    type: EMIT_SENTINEL,
    props: { __emit: "command", value },
    children: [],
  };
}

export function isEmitElement(node: unknown): node is EmitElement {
  return (
    typeof node === "object" &&
    node !== null &&
    (node as Element).type === EMIT_SENTINEL
  );
}
