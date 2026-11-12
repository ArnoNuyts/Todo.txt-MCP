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
import {
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  type Stats,
  type WriteFileOptions,
} from "node:fs";
import { dirname, join } from "node:path";
import { TextDecoder } from "node:util";
import { Todo } from "./todo.ts";
import { serializeTodoContent } from "./content.ts";
import { isNotFoundError } from "./fs-errors.ts";
import {
  assertFileSizeWithinLimit,
  resolveMaxFileBytes,
  resolveMaxLineChars,
  resolveMaxReadTodos,
} from "./limits.ts";
import { validateTodoFileContent } from "./todo-file-validation.ts";

export interface ReadTodosOptions {
  /** Maximum allowed file size in bytes. Defaults to `TODOTXT_MCP_MAX_FILE_BYTES`. */
  maxFileBytes?: number;
  /** Maximum number of physical lines. Defaults to `TODOTXT_MCP_MAX_READ_TODOS`. */
  maxReadTodos?: number;
  /** Maximum characters per line. Defaults to `TODOTXT_MCP_MAX_LINE_CHARS`. */
  maxLineChars?: number;
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
  const maxReadTodos = options.maxReadTodos ?? resolveMaxReadTodos();
  const maxLineChars = options.maxLineChars ?? resolveMaxLineChars();
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

  // Validate structure after decoding and before building Todo objects. The
  // returned lines keep their original bytes (including a CRLF terminator).
  const lines = validateTodoFileContent(data, { maxReadTodos, maxLineChars });

  return lines.filter((x) => x.trim()).map((x) => new Todo(x));
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

  // Atomic replacement only needs a writable directory, so honour an explicit
  // read-only mode instead of silently replacing the file anyway.
  if (targetInfo !== undefined && (targetInfo.mode & 0o222) === 0) {
    throw new Error(
      `Todo file "${filename}" is read-only; refusing to replace it. ` +
        "Clear the read-only bit and retry.",
    );
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

/**
 * Matches the temporary files created by `writeTodosToFile`: a dot, a UUID,
 * and `.tmp`. Anything else in the directory is left alone.
 */
const TEMP_FILE_PATTERN =
  /^\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i;

/** Only files untouched for an hour are considered abandoned. */
const DEFAULT_STALE_TEMP_AGE_MS = 60 * 60 * 1_000;

export interface CleanupStaleTempFilesOptions {
  /** Minimum age before a temp file is removed. Default: one hour. */
  maxAgeMs?: number;
  /** Injectable clock in milliseconds. Default: `Date.now()`. */
  now?: number;
}

/** Resolves the directory holding the real todo file, following symlinks. */
function resolveTodoDirectory(filename: string): string {
  try {
    return dirname(realpathSync(filename));
  } catch {
    return dirname(filename);
  }
}

/**
 * Best-effort removal of abandoned `.<uuid>.tmp` files next to the todo file.
 *
 * The write path removes its temp file on error, but a killed process can
 * leave one behind. Recent temp files are preserved because another writer may
 * be using them. Every filesystem error is swallowed so a read-only or missing
 * directory cannot prevent startup. Returns the number of files removed.
 */
export function cleanupStaleTempFiles(
  filename: string,
  options: CleanupStaleTempFilesOptions = {},
): number {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_STALE_TEMP_AGE_MS;
  const now = options.now ?? Date.now();
  const directory = resolveTodoDirectory(filename);

  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!TEMP_FILE_PATTERN.test(entry)) {
      continue;
    }
    const path = join(directory, entry);
    try {
      const info = statSync(path);
      if (!info.isFile() || now - info.mtimeMs <= maxAgeMs) {
        continue;
      }
      unlinkSync(path);
      removed += 1;
    } catch {
      // Another process may have removed it, or the directory is read-only.
    }
  }
  return removed;
}
