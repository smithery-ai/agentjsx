import { Chunk, Effect, Layer, Schema } from "effect";
import { AgentCtx, defineTool, type Event, type Extension } from "@flamecast/agentjsx";

// Mirrors Hermes's `todo_tool.py`. Single tool: `todo`. Calls with no
// args read; calls with `todos: [...]` write the full list.
//
// Event-sourced: the current todo list IS whatever the most recent
// `todo` tool's result wrote. The ambient walks the event log backwards
// and renders that result. No extension-local mutable state — the log
// is the source of truth, in line with effectctx principle #1.

export const TODO_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
] as const;

export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface TodoItem {
  readonly id: string;
  readonly content: string;
  readonly status: TodoStatus;
}

const StatusSchema = Schema.Literal(...TODO_STATUSES);

const TodoSchema = Schema.Struct({
  id: Schema.String,
  content: Schema.String,
  status: StatusSchema,
});

const isTodoItem = (v: unknown): v is TodoItem =>
  !!v &&
  typeof v === "object" &&
  typeof (v as TodoItem).id === "string" &&
  typeof (v as TodoItem).content === "string" &&
  TODO_STATUSES.includes((v as TodoItem).status);

const renderList = (items: readonly TodoItem[]): string => {
  if (items.length === 0) return "";
  const lines = items.map((t, i) => {
    const mark =
      t.status === "completed"
        ? "x"
        : t.status === "in_progress"
          ? "~"
          : t.status === "cancelled"
            ? "-"
            : " ";
    return `${i + 1}. [${mark}] ${t.content}  \`(${t.id}, ${t.status})\``;
  });
  return `## Current todos\n\n${lines.join("\n")}`;
};

// Walk the log backwards. Return the parsed todo list from the most
// recent successful `todo` write, or [] if none.
const latestTodos = (
  events: readonly Event[],
  toolName: string,
): readonly TodoItem[] => {
  const writeIds = new Set<string>();
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (
      ev.type === "tool.call.started" &&
      ev.tool_name === toolName
    ) {
      writeIds.add(ev.tool_call_id);
    }
  }
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (ev.type !== "tool.result") continue;
    if (!writeIds.has(ev.tool_call_id)) continue;
    try {
      const parsed = JSON.parse(ev.content);
      if (Array.isArray(parsed) && parsed.every(isTodoItem)) {
        return parsed;
      }
    } catch {
      // not a todo write (could be a read result with no array, etc.)
    }
  }
  return [];
};

export interface TodosOptions {
  readonly toolName?: string;
}

export const todos = (opts: TodosOptions = {}): Extension => {
  const toolName = opts.toolName ?? "todo";

  return Layer.scopedDiscard(
    Effect.gen(function* () {
      const ctx = yield* AgentCtx;
      const eventLog = ctx.events;

      yield* ctx.addAmbient({
        name: "hermes/todos",
        content: Effect.gen(function* () {
          const snap = yield* eventLog.snapshot;
          const items = latestTodos(Chunk.toReadonlyArray(snap), toolName);
          return renderList(items);
        }),
      });

      yield* ctx.addTool(
        defineTool({
          name: toolName,
          description:
            "Manage the working todo list. Call with no args to read; pass " +
            "`todos: [...]` to write the full list (overwrites). Use this to " +
            "decompose a complex task before starting, mark items in_progress " +
            "as you go, and completed when done. List order is priority. " +
            "Statuses: pending, in_progress, completed, cancelled.",
          parameters: Schema.Struct({
            todos: Schema.optional(Schema.Array(TodoSchema)),
          }),
          run: async ({ todos: next }, _toolCtx) => {
            if (next === undefined) {
              // Read path: re-derive from the log without using extension state.
              // The render driver will see the same answer next turn.
              return "Reading todos. Current list is shown in the system prompt.";
            }
            const seen = new Set<string>();
            for (const item of next) {
              if (seen.has(item.id)) {
                return `Error: duplicate todo id "${item.id}".`;
              }
              seen.add(item.id);
            }
            // The tool result IS the new list. The ambient producer
            // reads it back from the log on the next render.
            return JSON.stringify(next.map((t) => ({ ...t })));
          },
        }),
      ).pipe(
        Effect.catchTag("DuplicateToolError", (err) =>
          ctx.reportError("hermes/todos", err),
        ),
      );
    }),
  );
};
