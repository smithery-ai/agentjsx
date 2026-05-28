// Capability component — a per-agent todo list driven by the event log.
//
// State derivation: `todo.added` and `todo.completed` events are
// appended to the log via the tools' `extraEvents`. At render time the
// `<Todo>` block reduces over the agent's events to derive the current
// items list. The log is the source of truth (repo principle #1) —
// hydration replays the events and the block renders the same content
// without any side state.

import { Schema } from "effect";
import { defineTool } from "../../define-tool";
import type { Event, Fragment as RenderedFragment } from "../../types";
import { emitFragment, emitTool, type Element, type Node } from "../runtime";
import { useRenderContext } from "../render";

interface TodoItem {
  text: string;
  done: boolean;
}

// Reducer: derive the current `TodoItem[]` from the event log. Defensive
// against out-of-range `todo.completed` events — the tool always returns
// "ok" (see the architectural note on the tool body), so the projection
// has to tolerate completions that don't match an existing item.
function computeTodoItems(events: ReadonlyArray<Event>): TodoItem[] {
  const items: TodoItem[] = [];
  for (const e of events) {
    if (e.type === "todo.added") {
      items.push({ text: e.text, done: false });
    } else if (e.type === "todo.completed") {
      const item = items[e.index];
      if (item) item.done = true;
      // Out-of-range completion: silently ignored. The tool body
      // doesn't validate the index — keeping tools pure means
      // validation lives here in the projection.
    }
  }
  return items;
}

export function Todo(_props: Record<string, never> = {}): Node {
  void _props;
  const { events } = useRenderContext();
  const items = computeTodoItems(events);

  const todo_add = defineTool({
    name: "todo_add",
    description: "Append an item to the todo list.",
    parameters: Schema.Struct({
      text: Schema.String,
    }),
    // Pure tool: returns "ok" and declares one `todo.added` event for
    // the framework to append alongside the `tool.result`. The Todo
    // block re-renders from the updated event log on the next walk.
    run: async ({ text }) => ({
      content: "ok",
      extraEvents: [{ type: "todo.added", text }],
    }),
  });

  const todo_complete = defineTool({
    name: "todo_complete",
    description: "Mark a todo item as completed by its 0-based index.",
    parameters: Schema.Struct({
      index: Schema.Number,
    }),
    // Pure tool: emits the completion event unconditionally. The
    // projection reducer ignores out-of-range indices, so an invalid
    // completion is a no-op rather than an error. Validation could
    // live in the tool by snapshotting the items at render time, but
    // keeping tools pure (no closure-state reads) is the architectural
    // preference — projections own defensive interpretation.
    run: async ({ index }) => ({
      content: "ok",
      extraEvents: [{ type: "todo.completed", index }],
    }),
  });

  const inner =
    items.length === 0
      ? "(none)"
      : items
          .map(
            (item, i) =>
              `[${item.done ? "x" : " "}] ${i}: ${item.text}`,
          )
          .join("\n");

  const block: RenderedFragment = {
    tag: "core/system",
    content: `<todo>\n${inner}\n</todo>`,
    source: "todo",
  };

  const emits: Element[] = [
    emitTool(todo_add),
    emitTool(todo_complete),
    emitFragment(block),
  ];
  return emits as Node;
}
