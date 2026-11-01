import type { Todo } from "./todo.ts";

export interface TodoSummaryReport {
  total: number;
  open: number;
  done: number;
  overdue: number;
  status: { todo: number; done: number };
  contexts: Record<string, number>;
  projects: Record<string, number>;
  priorities: Record<string, number>;
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function sortedRecord(counts: Map<string, number>): Record<string, number> {
  return Object.fromEntries(
    [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
}

/**
 * Counts todos by status, context, project and priority, plus the number of
 * open todos past their `due:` date. Context, project and priority keys are
 * lowercased so grouping matches the case-insensitive list filters.
 */
export function summarizeTodos(todos: readonly Todo[]): TodoSummaryReport {
  const contexts = new Map<string, number>();
  const projects = new Map<string, number>();
  const priorities = new Map<string, number>();
  let open = 0;
  let done = 0;
  let overdue = 0;

  for (const todo of todos) {
    if (todo.isDone()) {
      done += 1;
    } else {
      open += 1;
      if (todo.isOverdue()) {
        overdue += 1;
      }
    }

    for (const context of todo.contexts) {
      increment(contexts, context.toLowerCase());
    }
    for (const project of todo.projects) {
      increment(projects, project.toLowerCase());
    }
    increment(priorities, (todo.priority ?? "none").toLowerCase());
  }

  return {
    total: todos.length,
    open,
    done,
    overdue,
    status: { todo: open, done },
    contexts: sortedRecord(contexts),
    projects: sortedRecord(projects),
    priorities: sortedRecord(priorities),
  };
}
