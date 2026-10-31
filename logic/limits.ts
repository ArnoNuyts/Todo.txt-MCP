export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
export const DEFAULT_MAX_TODOS = 10_000;

/**
 * Parses a positive integer from an environment variable, falling back to the
 * provided default when unset or empty. Invalid values raise a clear error
 * instead of silently disabling a safety limit.
 */
export function parsePositiveIntegerEnv(
  value: string | undefined,
  fallback: number,
  variable: string,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid ${variable} "${value}": expected a positive integer.`,
    );
  }

  return parsed;
}

/** Resolves the todo file size limit in bytes (`TODOTXT_MCP_MAX_FILE_BYTES`). */
export function resolveMaxFileBytes(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveIntegerEnv(
    env.TODOTXT_MCP_MAX_FILE_BYTES,
    DEFAULT_MAX_FILE_BYTES,
    "TODOTXT_MCP_MAX_FILE_BYTES",
  );
}

/** Resolves the total todo count limit (`TODOTXT_MCP_MAX_TODOS`). */
export function resolveMaxTodos(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveIntegerEnv(
    env.TODOTXT_MCP_MAX_TODOS,
    DEFAULT_MAX_TODOS,
    "TODOTXT_MCP_MAX_TODOS",
  );
}

/**
 * Throws when `byteLength` exceeds `maxFileBytes`. Used both before reading
 * (based on `stat`/`Content-Length`) and after reading (based on the actual
 * UTF-8 byte length), so an oversized todo file never gets parsed into memory
 * needlessly.
 */
export function assertFileSizeWithinLimit(
  source: string,
  byteLength: number,
  maxFileBytes: number,
): void {
  if (byteLength > maxFileBytes) {
    throw new Error(
      `${source} is too large: ${byteLength} bytes exceeds the ` +
        `${maxFileBytes}-byte limit set by TODOTXT_MCP_MAX_FILE_BYTES.`,
    );
  }
}
