import { Todo } from "./todo.ts";

/**
 * Canonical serialized form of a todo list. This matches what the file
 * backends write.
 */
export function serializeTodoContent(todos: readonly Todo[]): string {
  return todos.map((todo) => todo.toString()).join("\n") + "\n";
}
