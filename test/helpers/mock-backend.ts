import type { TodoBackend } from "../../logic/backend.ts";
import type { Todo } from "../../logic/todo.ts";

/** In-memory {@link TodoBackend} used by the server and MCP tests. */
export class MockBackend implements TodoBackend {
  private _todos: Todo[] = [];
  /** Number of `load` calls, for asserting single-load batch operations. */
  loadCalls = 0;
  /** Number of `save` calls, for asserting single-save batch operations. */
  saveCalls = 0;

  load(): Promise<Todo[]> {
    this.loadCalls += 1;
    return Promise.resolve(this._todos);
  }

  save(todos: Todo[]): Promise<void> {
    this.saveCalls += 1;
    this._todos = todos;
    return Promise.resolve();
  }

  /** Not part of the backend contract; handy for assertions in tests. */
  getTodos(): Todo[] {
    return this._todos;
  }

  reset() {
    this._todos = [];
    this.loadCalls = 0;
    this.saveCalls = 0;
  }
}
