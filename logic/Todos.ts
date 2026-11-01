import { Todo } from "./todo.ts";
import { TodoStateEnum } from "../types/enums.ts";

export type TodoSortOrder = "creation" | "completion" | "priority" | "text";

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
  sort?: TodoSortOrder;
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

function compareDates(a: Date | undefined, b: Date | undefined): number {
  if (a === undefined && b === undefined) {
    return 0;
  }
  if (a === undefined) {
    return 1;
  }
  if (b === undefined) {
    return -1;
  }
  return a.getTime() - b.getTime();
}

/** Returns a copy of `todos` in the requested order (file order by default). */
export function sortTodos(
  todos: readonly Todo[],
  sort?: TodoSortOrder,
): Todos {
  const sorted = new Todos(...todos);
  switch (sort) {
    case undefined:
      return sorted;
    case "creation":
      return sorted.sort((a, b) =>
        compareDates(a.creationDate, b.creationDate)
      );
    case "completion":
      return sorted.sort((a, b) =>
        compareDates(a.completionDate, b.completionDate)
      );
    case "priority":
      return sorted.sort((a, b) => {
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
      });
    case "text":
      return sorted.sort((a, b) =>
        a.toDisplayString().localeCompare(b.toDisplayString())
      );
  }
}

/** Applies every filter and then the requested sort order. */
export function selectTodos(
  todos: readonly Todo[],
  filters: TodoFilterOptions = {},
): Todos {
  return sortTodos(filterTodos(todos, filters), filters.sort);
}

/** Encodes an offset as an opaque, URL-safe pagination cursor. */
export function encodeListCursor(offset: number): string {
  return Buffer.from(`offset:${offset}`, "utf8").toString("base64url");
}

/** Decodes a cursor produced by {@link encodeListCursor}. */
export function decodeListCursor(cursor: string): number {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const match = /^offset:(\d+)$/.exec(decoded);
  if (match === null) {
    throw new Error("Invalid cursor");
  }
  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset)) {
    throw new Error("Invalid cursor");
  }
  return offset;
}

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
