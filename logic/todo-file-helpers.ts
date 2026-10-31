import { randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { Stats, WriteFileOptions } from "node:fs";
import { dirname, join } from "node:path";
import { Todo } from "./todo.ts";
import { Todos } from "./Todos.ts";
import { isNotFoundError } from "./fs-errors.ts";
import {
  assertFileSizeWithinLimit,
  resolveMaxFileBytes,
} from "./limits.ts";

export interface ReadTodosOptions {
  /** Maximum allowed file size in bytes. Defaults to `TODOTXT_MCP_MAX_FILE_BYTES`. */
  maxFileBytes?: number;
}

export async function readTodosFromFile(
  filename: string,
  options: ReadTodosOptions = {},
): Promise<Todos> {
  const maxFileBytes = options.maxFileBytes ?? resolveMaxFileBytes();
  let fileInfo: Stats;
  try {
    fileInfo = await stat(filename); // Check if file exists
  } catch (error) {
    if (isNotFoundError(error)) {
      await writeFile(filename, ""); // Create the file if it doesn't exist
      return new Todos(); // Return empty Todos after creating the file
    }
    throw error; // Re-throw other errors from stat()
  }

  // Check the size before reading so an oversized file is never loaded.
  assertFileSizeWithinLimit(
    `Todo file "${filename}"`,
    fileInfo.size,
    maxFileBytes,
  );

  let data: string;
  try {
    data = await readFile(filename, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Error reading file "${filename}": ${message}`, {
      cause: error,
    });
  }

  // Re-check the byte length after reading in case the file grew in between.
  assertFileSizeWithinLimit(
    `Todo file "${filename}"`,
    Buffer.byteLength(data, "utf8"),
    maxFileBytes,
  );

  return new Todos(
    ...data.split("\n").filter((x) => x.trim()).map((x) => new Todo(x)),
  );
}

/**
 * Writes todos atomically: the content is written to a unique temporary file
 * in the same directory and then renamed over the target file. A partially
 * written file is therefore never observable at `filename`.
 */
export const writeTodosToFile = async (
  todos: Todo[],
  filename: string,
  writeOptions: WriteFileOptions | undefined = undefined,
) => {
  const content = todos.map((y) => y.toString()).join("\n") + "\n";
  const tempFilename = join(dirname(filename), `.${randomUUID()}.tmp`);

  try {
    await writeFile(tempFilename, content, writeOptions);
    await rename(tempFilename, filename);
  } catch (error) {
    await rm(tempFilename, { force: true }).catch(() => undefined);
    throw error;
  }
};
