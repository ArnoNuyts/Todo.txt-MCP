import type { TodoBackend } from "../backend.ts";
import { Todo } from "../todo.ts";
import { readTodosFromFile, writeTodosToFile } from "../todo-file-helpers.ts";

export class LocalFileBackend implements TodoBackend {
  private readonly filename: string;

  constructor(filename: string) {
    this.filename = filename;
  }

  async load(): Promise<Todo[]> {
    return await readTodosFromFile(this.filename);
  }

  async save(todos: Todo[]): Promise<void> {
    await writeTodosToFile(todos, this.filename);
  }
}
