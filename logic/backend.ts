import { Todo } from "./todo.ts";

export interface TodoBackend {
  load(): Promise<Todo[]>;
  save(todos: Todo[]): Promise<void>;
  /**
   * Optionally serializes a whole load -> mutate -> save cycle against other
   * processes that share the same storage. Implemented by the local-file
   * backend with an advisory lock file; the WebDAV backend relies on
   * `If-Match` instead and leaves this undefined.
   */
  withLock?<T>(work: () => Promise<T>): Promise<T>;
}
