import { createHash } from "node:crypto";
import { Todo } from "./todo.ts";

/**
 * Canonical serialized form of a todo list. This matches what the file
 * backends write, so the same list always produces the same version.
 */
export function serializeTodoContent(todos: readonly Todo[]): string {
  return todos.map((todo) => todo.toString()).join("\n") + "\n";
}

/**
 * Stable content version: the SHA-256 hex digest of the serialized content.
 * Two loads of the same file bytes produce the same version, and any change
 * to the todos changes it.
 */
export function computeContentVersion(todos: readonly Todo[]): string {
  return createHash("sha256")
    .update(serializeTodoContent(todos), "utf8")
    .digest("hex");
}

/** Parses todo.txt content, ignoring blank lines. */
export function parseTodoContent(content: string): Todo[] {
  return content
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => new Todo(line));
}

/** Counts how many lines would be added, removed, or kept unchanged. */
export interface TodoContentDiff {
  added: number;
  removed: number;
  unchanged: number;
}

/** Multiset diff between the current and the prospective todo content. */
export function diffTodoContent(
  current: readonly Todo[],
  next: readonly Todo[],
): TodoContentDiff {
  const count = (todos: readonly Todo[]) => {
    const counts = new Map<string, number>();
    for (const todo of todos) {
      const line = todo.toString();
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
    return counts;
  };

  const currentCounts = count(current);
  const nextCounts = count(next);
  let added = 0;
  let removed = 0;
  let unchanged = 0;

  for (const [line, nextCount] of nextCounts) {
    const currentCount = currentCounts.get(line) ?? 0;
    added += Math.max(0, nextCount - currentCount);
    unchanged += Math.min(nextCount, currentCount);
  }
  for (const [line, currentCount] of currentCounts) {
    const nextCount = nextCounts.get(line) ?? 0;
    removed += Math.max(0, currentCount - nextCount);
  }

  return { added, removed, unchanged };
}
