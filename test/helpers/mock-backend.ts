import type { TodoBackend } from "../../logic/backend.ts";
import type { Todo } from "../../logic/todo.ts";

/** In-memory {@link TodoBackend} used by the server and MCP tests. */
export class MockBackend implements TodoBackend {
  private _todos: Todo[] = [];

  load(): Promise<Todo[]> {
    return Promise.resolve(this._todos);
  }

  save(todos: Todo[]): Promise<void> {
    this._todos = todos;
    return Promise.resolve();
  }

  /** Not part of the backend contract; handy for assertions in tests. */
  getTodos(): Todo[] {
    return this._todos;
  }

  reset() {
    this._todos = [];
  }
}
