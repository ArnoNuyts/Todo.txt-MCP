import { Todo } from "./todo.ts";
import { Todos } from "./Todos.ts";

export async function readTodosFromFile(filename: string) {
  try {
    await Deno.stat(filename); // Check if file exists
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      await Deno.writeTextFile(filename, ""); // Create the file if it doesn't exist
      return new Todos(); // Return empty Todos after creating the file
    }
    throw error; // Re-throw other errors from stat()
  }

  try {
    // Read the file content
    const data = await Deno.readTextFile(filename);

    return new Todos(
      ...data.split("\n").filter((x) => x.trim()).map((x) => new Todo(x)),
    );

    // deno-lint-ignore no-explicit-any
  } catch (err: any) {
    console.error(`Error reading file "${filename}":`, err.message);
    Deno.exit(1);
  }
}

export const writeTodosToFile = async (
  todos: Todo[],
  filename: string,
  writeOptions: Deno.WriteFileOptions | undefined = undefined,
) =>
  await Deno.writeTextFile(
    filename,
    todos.map((y) => y.toString()).join("\n") + "\n",
    writeOptions,
  );
