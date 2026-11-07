import { randomUUID } from "node:crypto";
import {
  chmod,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import type { Stats, WriteFileOptions } from "node:fs";
import { dirname, join } from "node:path";
import { TextDecoder } from "node:util";
import { Todo } from "./todo.ts";
import { serializeTodoContent } from "./content.ts";
import { isNotFoundError } from "./fs-errors.ts";
import {
  assertFileSizeWithinLimit,
  resolveMaxFileBytes,
} from "./limits.ts";

export interface ReadTodosOptions {
  /** Maximum allowed file size in bytes. Defaults to `TODOTXT_MCP_MAX_FILE_BYTES`. */
  maxFileBytes?: number;
}

export interface WriteTodosOptions {
  /** Maximum allowed file size in bytes. Defaults to `TODOTXT_MCP_MAX_FILE_BYTES`. */
  maxFileBytes?: number;
}

export async function readTodosFromFile(
  filename: string,
  options: ReadTodosOptions = {},
): Promise<Todo[]> {
  const maxFileBytes = options.maxFileBytes ?? resolveMaxFileBytes();
  let fileInfo: Stats;
  try {
    fileInfo = await stat(filename); // Check if file exists
  } catch (error) {
    if (isNotFoundError(error)) {
      await writeFile(filename, ""); // Create the file if it doesn't exist
      return []; // Return an empty list after creating the file
    }
    throw error; // Re-throw other errors from stat()
  }

  // Check the size before reading so an oversized file is never loaded.
  assertFileSizeWithinLimit(
    `Todo file "${filename}"`,
    fileInfo.size,
    maxFileBytes,
  );

  let buffer: Buffer;
  try {
    buffer = await readFile(filename);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Error reading file "${filename}": ${message}`, {
      cause: error,
    });
  }

  // Decode strictly. Replacing invalid bytes with U+FFFD would silently alter
  // untouched lines as soon as the parsed list is written back.
  let data: string;
  try {
    data = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      buffer,
    );
  } catch (error) {
    throw new Error(
      `Todo file "${filename}" is not valid UTF-8; refusing to read it. ` +
        "Re-save the file with UTF-8 encoding before trying again.",
      { cause: error },
    );
  }

  // Re-check the byte length after reading in case the file grew in between.
  assertFileSizeWithinLimit(
    `Todo file "${filename}"`,
    buffer.length,
    maxFileBytes,
  );

  return data.split("\n").filter((x) => x.trim()).map((x) => new Todo(x));
}

/**
 * Resolves symlinks so the write replaces the real file instead of the link.
 * A missing target (including a dangling link) falls back to `filename`.
 */
async function resolveWriteTarget(filename: string): Promise<string> {
  try {
    return await realpath(filename);
  } catch (error) {
    if (isNotFoundError(error)) {
      return filename;
    }
    throw error;
  }
}

/**
 * Writes todos atomically: the content is written to a unique temporary file
 * in the same directory as the real target and then renamed over it. A
 * partially written file is therefore never observable at `filename`.
 *
 * The existing file's permission bits are preserved, and symlinks are followed
 * so the link itself survives the replacement.
 */
export const writeTodosToFile = async (
  todos: Todo[],
  filename: string,
  writeOptions: WriteFileOptions | undefined = undefined,
  options: WriteTodosOptions = {},
) => {
  const content = serializeTodoContent(todos);
  const maxFileBytes = options.maxFileBytes ?? resolveMaxFileBytes();

  // Reject before creating a temp file. Otherwise a successful write could push
  // the file over the limit, making every subsequent read fail (self-lockout).
  assertFileSizeWithinLimit(
    `Todo file "${filename}"`,
    Buffer.byteLength(content, "utf8"),
    maxFileBytes,
  );

  const targetFilename = await resolveWriteTarget(filename);

  let targetInfo: Stats | undefined;
  try {
    targetInfo = await stat(targetFilename);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  // writeOptions may be a bare encoding string, in which case it cannot
  // override the mode. writeFile's mode is filtered through the umask, so
  // chmod afterwards to keep the exact bits of the replaced file.
  const explicitMode = typeof writeOptions === "object" && writeOptions !== null
    ? writeOptions.mode
    : undefined;
  const inheritedMode = explicitMode === undefined && targetInfo !== undefined
    ? targetInfo.mode & 0o777
    : undefined;
  const effectiveWriteOptions: WriteFileOptions | undefined =
    inheritedMode === undefined ? writeOptions : {
      ...(typeof writeOptions === "string"
        ? { encoding: writeOptions }
        : writeOptions ?? {}),
      mode: inheritedMode,
    };

  const tempFilename = join(dirname(targetFilename), `.${randomUUID()}.tmp`);

  try {
    await writeFile(tempFilename, content, effectiveWriteOptions);
    if (inheritedMode !== undefined) {
      await chmod(tempFilename, inheritedMode);
    }
    await rename(tempFilename, targetFilename);
  } catch (error) {
    await rm(tempFilename, { force: true }).catch(() => undefined);
    throw error;
  }
};
