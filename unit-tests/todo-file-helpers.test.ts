import { assertEquals } from "https://deno.land/std@0.201.0/assert/mod.ts";
import { readTodosFromFile } from "../logic/todo-file-helpers.ts";
import { Todos } from "../logic/Todos.ts"; // Needed for new Todos()

Deno.test("readTodosFromFile - should return empty Todos and create file if not found", async () => {
  const tempFilename = `temp_test_file_${Date.now()}.txt`;

  try {
    // Ensure file does not exist before test
    try {
      await Deno.remove(tempFilename);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    const todos = await readTodosFromFile(tempFilename);

    assertEquals(todos.length, 0, "Should return an empty Todos object");

    // Check if the file was created
    const fileInfo = await Deno.stat(tempFilename);
    assertEquals(fileInfo.isFile, true, "File should be created");
  } finally {
    // Clean up
    try {
      await Deno.remove(tempFilename);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        console.error(`Error cleaning up temp file ${tempFilename}:`, error);
      }
    }
  }
});
