import { Todo } from "./todo.ts";

export interface TodoBackend {
  /**
   * Reads the current list. Callers must load before every save: remote
   * backends capture a revision here and use it to reject concurrent writes.
   */
  load(): Promise<Todo[]>;
  /**
   * Persists the full list. A save must follow a load; the WebDAV backend
   * uses the revision captured by that load as its `If-Match` precondition.
   */
  save(todos: Todo[]): Promise<void>;
  /**
   * Optionally serializes a whole load -> mutate -> save cycle against other
   * processes that share the same storage. Implemented by the local-file
   * backend with an advisory lock file; the WebDAV backend relies on
   * `If-Match` instead and leaves this undefined.
   */
  withLock?<T>(work: () => Promise<T>): Promise<T>;
}
