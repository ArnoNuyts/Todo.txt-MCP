import { Todo } from "./todo.ts";
import { TodoStateEnum } from "../types/enums.ts";

/** Filters accepted by `list_todos`; every provided filter is combined with AND. */
export interface TodoFilterOptions {
  status?: "todo" | "done" | "all";
  search?: string;
  context?: string;
}

/**
 * Tests an `@context` token for an exact, case-insensitive match. The leading
 * marker is optional in the input.
 */
function matchesContext(todo: Todo, context: string): boolean {
  const normalized = context.trim().replace(/^@/, "").toLowerCase();
  if (normalized === "") {
    return false;
  }

  for (const value of todo.contexts) {
    if (value.toLowerCase() === normalized) {
      return true;
    }
  }

  // The parser only recognizes tokens preceded by whitespace, so also check
  // the raw text with an explicit start anchor.
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)@${escaped}(?=$|\\s)`, "i").test(todo.text);
}

/** Filters todos by status, text, and context. */
export function filterTodos(
  todos: readonly Todo[],
  filters: TodoFilterOptions = {},
): Todo[] {
  return todos.filter((todo) => {
    if (filters.status !== undefined && filters.status !== "all") {
      const targetState = filters.status === "done"
        ? TodoStateEnum.done
        : TodoStateEnum.todo;
      if (todo.state !== targetState) {
        return false;
      }
    }

    if (filters.search) {
      const needle = filters.search.toLowerCase();
      if (!todo.toDisplayString().toLowerCase().includes(needle)) {
        return false;
      }
    }

    if (
      filters.context !== undefined &&
      !matchesContext(todo, filters.context)
    ) {
      return false;
    }

    return true;
  });
}
