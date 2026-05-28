// Core function components for the JSX-context API.
//
// Classic JSX mode: tsconfig has `jsxFactory: "createElement"`. Every
// file that uses JSX syntax must import `createElement` explicitly so
// the compiled output resolves. Some components here don't use JSX
// syntax directly, but the import is harmless and keeps the pattern
// uniform across the directory.

import { Chunk } from "effect";
import { renderHistoryFragments } from "../projections";
import type { Event, Fragment as RenderedFragment } from "../types";
import { emitFragment } from "./runtime";
import type { Element, Node } from "./runtime";
import { useRenderContext } from "./render";

// ---------------------------------------------------------------------
// <Agent>
//
// Transparent root marker. Returns its children unchanged so the walker
// recurses normally. Existence is conventional — it names the root of
// the JSX tree but contributes nothing on its own.
// ---------------------------------------------------------------------

export interface AgentProps {
  readonly children?: Node | Node[];
}

export function Agent(props: AgentProps): Node {
  const children = props.children;
  if (children === undefined) return [];
  return children as Node;
}

// ---------------------------------------------------------------------
// <Block name="...">text</Block>
//
// Emits a single `core/system` fragment whose `content` is the
// stringified children. Children must be leaf text — nested Elements
// are refused so the MVP stays small. Power users who want nested
// composition write helpers that return strings.
// ---------------------------------------------------------------------

export interface BlockProps {
  readonly name: string;
  readonly children?: Node | Node[];
}

function stringifyChildren(children: Node | undefined): string {
  if (children === undefined || children === null) return "";
  if (typeof children === "boolean") return "";
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) {
    let out = "";
    for (const child of children) out += stringifyChildren(child as Node);
    return out;
  }
  // It's an Element.
  throw new Error(
    "Block children must be text; got nested element. Use plain strings or string-returning helpers.",
  );
}

export function Block(props: BlockProps): Node {
  const content = stringifyChildren(props.children);
  const fragment: RenderedFragment = {
    tag: "core/system",
    content,
    source: props.name,
  };
  return emitFragment(fragment);
}

// ---------------------------------------------------------------------
// <Messages /> or <Messages from={events} />
//
// Projects events into history fragments via `renderHistoryFragments`.
// When `from` is omitted, reads `events` from the ambient render
// context (set by `render()`).
// ---------------------------------------------------------------------

export interface MessagesProps {
  readonly from?: ReadonlyArray<Event>;
}

export function Messages(props: MessagesProps): Node {
  const events = props.from ?? useRenderContext().events;
  const fragments = renderHistoryFragments(Chunk.fromIterable(events));
  const emits: Element[] = fragments.map((f) => emitFragment(f));
  return emits as Node;
}
