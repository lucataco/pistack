// `pistack_todo`: Cursor's todo list. State lives in tool-result details, so it follows the session branch.

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface Todo {
  id: string;
  content: string;
  status: TodoStatus;
}

export interface TodoDetails {
  todos: Todo[];
}

const MARK: Record<TodoStatus, string> = { pending: "[ ]", in_progress: "[~]", completed: "[x]", cancelled: "[-]" };

/** Merge updates by id (new ids append), or replace the whole list. */
export function applyTodos(current: readonly Todo[], updates: readonly Partial<Todo>[], merge: boolean): Todo[] {
  if (!merge) {
    return updates.map((todo, index) => ({
      id: todo.id ?? String(index + 1),
      content: todo.content ?? "",
      status: todo.status ?? "pending",
    }));
  }
  const next = current.map((todo) => ({ ...todo }));
  for (const update of updates) {
    const existing = update.id === undefined ? undefined : next.find((todo) => todo.id === update.id);
    if (existing) {
      if (update.content !== undefined) existing.content = update.content;
      if (update.status !== undefined) existing.status = update.status;
    } else {
      next.push({ id: update.id ?? String(next.length + 1), content: update.content ?? "", status: update.status ?? "pending" });
    }
  }
  return next;
}

export function formatTodos(todos: readonly Todo[]): string {
  if (!todos.length) return "The todo list is empty.";
  const done = todos.filter((todo) => todo.status === "completed").length;
  return [`${done}/${todos.length} completed`, ...todos.map((todo) => `${MARK[todo.status]} ${todo.id}. ${todo.content}`)].join("\n");
}

export class TodoState {
  todos: Todo[] = [];

  restore(ctx: ExtensionContext): void {
    this.todos = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const message = entry.message as { role?: string; toolName?: string; details?: TodoDetails };
      if (message.role === "toolResult" && message.toolName === "pistack_todo" && message.details?.todos) {
        this.todos = message.details.todos.map((todo) => ({ ...todo }));
      }
    }
  }

  progress(): { done: number; total: number; current?: string } {
    const live = this.todos.filter((todo) => todo.status !== "cancelled");
    return {
      done: live.filter((todo) => todo.status === "completed").length,
      total: live.length,
      current: this.todos.find((todo) => todo.status === "in_progress")?.content,
    };
  }
}

export function registerTodoTool(pi: ExtensionAPI, state: TodoState, onChange: () => void): void {
  pi.registerTool({
    name: "pistack_todo",
    label: "pistack todo",
    description:
      "Write the run's todo list (Cursor's todo list). Pass `todos` as { id, content, status } with status pending, in_progress, completed, or cancelled. `merge: true` updates items by id and appends new ids; `merge: false` replaces the list. Keep exactly one item in_progress while working.",
    promptSnippet: "Keep the run's todo list (Cursor's todolist)",
    parameters: Type.Object(
      {
        todos: Type.Array(
          Type.Object(
            {
              id: Type.String(),
              content: Type.Optional(Type.String()),
              status: Type.Optional(StringEnum(TODO_STATUSES)),
            },
            { additionalProperties: false },
          ),
        ),
        merge: Type.Optional(Type.Boolean({ description: "Update by id instead of replacing. Default: false." })),
      },
      { additionalProperties: false },
    ),
    defaultActive: false,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      state.todos = applyTodos(state.todos, params.todos as Partial<Todo>[], params.merge ?? false);
      onChange();
      const details: TodoDetails = { todos: state.todos.map((todo) => ({ ...todo })) };
      return { content: [{ type: "text", text: formatTodos(state.todos) }], details: details as unknown as Record<string, unknown> };
    },
    renderResult(result, { expanded }, theme) {
      const todos = (result.details as unknown as TodoDetails | undefined)?.todos ?? [];
      if (!todos.length) return new Text(theme.fg("dim", "todo list cleared"), 0, 0);
      const done = todos.filter((todo) => todo.status === "completed").length;
      const shown = expanded ? todos : todos.filter((todo) => todo.status !== "completed" && todo.status !== "cancelled").slice(0, 6);
      const lines = [theme.fg("muted", `${done}/${todos.length} completed`)];
      for (const todo of shown) {
        const color = todo.status === "completed" ? "success" : todo.status === "in_progress" ? "accent" : "dim";
        lines.push(`${theme.fg(color, MARK[todo.status])} ${todo.status === "in_progress" ? theme.bold(todo.content) : todo.content}`);
      }
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
