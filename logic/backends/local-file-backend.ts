import type { TodoBackend } from "../backend.ts";
import { Todo } from "../todo.ts";
import { withFileLock, type FileLockOptions } from "../file-lock.ts";
import {
  cleanupStaleTempFiles,
  readTodosFromFile,
  writeTodosToFile,
} from "../todo-file-helpers.ts";

export class LocalFileBackend implements TodoBackend {
  private readonly filename: string;
  private readonly lockOptions: FileLockOptions;

  constructor(filename: string, lockOptions: FileLockOptions = {}) {
    this.filename = filename;
    this.lockOptions = lockOptions;
    // A killed writer can leave an abandoned temp file; clean old ones without
    // making construction async or letting a read-only directory break startup.
    cleanupStaleTempFiles(filename);
  }

  async load(): Promise<Todo[]> {
    return await readTodosFromFile(this.filename);
  }

  async save(todos: Todo[]): Promise<void> {
    await writeTodosToFile(todos, this.filename);
  }

  /**
   * Serializes the whole load -> mutate -> save cycle against other processes
   * using an advisory lock file next to the todo file.
   */
  async withLock<T>(work: () => Promise<T>): Promise<T> {
    return await withFileLock(this.filename, work, this.lockOptions);
  }
}
