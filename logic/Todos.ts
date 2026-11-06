import { Todo } from "./todo.ts";
import { TodoStateEnum } from "../types/enums.ts";

/** Filters accepted by `list_todos`; every provided filter is combined with AND. */
export interface TodoFilterOptions {
  status?: "todo" | "done" | "all";
  search?: string;
  context?: string;
  project?: string;
  priority?: string;
  tag?: Record<string, string>;
  dueBefore?: string;
  createdAfter?: string;
}

const dateOnly = (date: Date) => date.toISOString().substring(0, 10);

function tagValues(todo: Todo, key: string): string[] {
  const value = todo.tags[key];
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

/**
 * Tests an `@context` or `+project` token for an exact, case-insensitive
 * match. The leading marker is optional in the input.
 */
function matchesToken(
  todo: Todo,
  token: string,
  marker: "@" | "+",
): boolean {
  const normalized = token.trim().replace(
    new RegExp(`^\\${marker}`),
    "",
  ).toLowerCase();
  if (normalized === "") {
    return false;
  }

  const values = marker === "@" ? todo.contexts : todo.projects;
  for (const value of values) {
    if (value.toLowerCase() === normalized) {
      return true;
    }
  }

  // The parser only recognizes tokens preceded by whitespace, so also check
  // the raw text with an explicit start anchor.
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const markerPattern = marker === "+" ? "\\+" : "@";
  return new RegExp(
    `(?:^|\\s)${markerPattern}${escaped}(?=$|\\s)`,
    "i",
  ).test(todo.text);
}

/** Filters todos by status, text, context, project, priority, tags, and dates. */
export function filterTodos(
  todos: readonly Todo[],
  filters: TodoFilterOptions = {},
): Todos {
  const filtered = todos.filter((todo) => {
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
      !matchesToken(todo, filters.context, "@")
    ) {
      return false;
    }

    if (
      filters.project !== undefined &&
      !matchesToken(todo, filters.project, "+")
    ) {
      return false;
    }

    if (filters.priority !== undefined && todo.priority !== filters.priority) {
      return false;
    }

    if (filters.tag !== undefined) {
      for (const [key, expected] of Object.entries(filters.tag)) {
        if (!tagValues(todo, key).includes(expected)) {
          return false;
        }
      }
    }

    if (filters.dueBefore !== undefined) {
      if (
        !tagValues(todo, "due").some((due) => due < filters.dueBefore!)
      ) {
        return false;
      }
    }

    if (filters.createdAfter !== undefined) {
      if (
        todo.creationDate === undefined ||
        dateOnly(todo.creationDate) <= filters.createdAfter
      ) {
        return false;
      }
    }

    return true;
  });

  return new Todos(...filtered);
}

/** Array subclass with the sorting helpers used by the tests. */
export class Todos extends Array<Todo> {
  sortByImportance = (): Todos =>
    new Todos(...this)
      .sort((a, b) => {
        if (a.priority === undefined && b.priority === undefined) {
          return 0;
        }
        if (a.priority === undefined) {
          return 1;
        }
        if (b.priority === undefined) {
          return -1;
        }
        return a.priority.localeCompare(b.priority);
      })
      .sort((a, b) => (b.isOverdue() ? 1 : 0) - (a.isOverdue() ? 1 : 0))
      .sort((a, b) => {
        const aContext = [...a.contexts][0];
        const bContext = [...b.contexts][0];
        if (aContext === undefined && bContext === undefined) {
          return 0;
        }
        if (aContext === undefined) {
          return -1;
        }
        if (bContext === undefined) {
          return 1;
        }
        return aContext.localeCompare(bContext);
      })
      .sort((a, b) => a.state - b.state) as Todos;
  filterHidden = () =>
    new Todos(...this.filter((todo) => todo.isVisibleInOverview()));
}
