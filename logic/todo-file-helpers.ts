import { readFile, stat, writeFile } from "node:fs/promises";
import type { WriteFileOptions } from "node:fs";
import { Todo } from "./todo.ts";
import { Todos } from "./Todos.ts";
import { isNotFoundError } from "./fs-errors.ts";

export async function readTodosFromFile(filename: string): Promise<Todos> {
  try {
    await stat(filename); // Check if file exists
  } catch (error) {
    if (isNotFoundError(error)) {
      await writeFile(filename, ""); // Create the file if it doesn't exist
      return new Todos(); // Return empty Todos after creating the file
    }
    throw error; // Re-throw other errors from stat()
  }

  try {
    const data = await readFile(filename, "utf8");
    return new Todos(
      ...data.split("\n").filter((x) => x.trim()).map((x) => new Todo(x)),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Error reading file "${filename}": ${message}`, {
      cause: error,
    });
  }
}

export const writeTodosToFile = async (
  todos: Todo[],
  filename: string,
  writeOptions: WriteFileOptions | undefined = undefined,
) =>
  await writeFile(
    filename,
    todos.map((y) => y.toString()).join("\n") + "\n",
    writeOptions,
  );
