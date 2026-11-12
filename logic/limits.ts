export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
export const DEFAULT_MAX_TODOS = 10_000;
/**
 * Read-side cap, deliberately larger than the 10,000 write cap. It keeps an
 * over-cap file readable and deletable through MCP instead of bricking it.
 */
export const DEFAULT_MAX_READ_TODOS = 50_000;
/** Hard ceiling for one physical todo.txt line on the read path. */
export const DEFAULT_MAX_LINE_CHARS = 8_192;

/**
 * Domain error for an exceeded file-size limit. It deliberately lives here
 * instead of the tool layer so storage backends and file helpers do not import
 * the MCP error envelope. `tool-errors.ts` maps it to `LIMIT_EXCEEDED`.
 */
export class LimitExceededError extends Error {
  readonly source: string;
  readonly byteLength: number;
  readonly maxFileBytes: number;

  constructor(source: string, byteLength: number, maxFileBytes: number) {
    super(
      `${source} is too large: ${byteLength} bytes exceeds the ` +
        `${maxFileBytes}-byte limit set by TODOTXT_MCP_MAX_FILE_BYTES.`,
    );
    this.name = "LimitExceededError";
    this.source = source;
    this.byteLength = byteLength;
    this.maxFileBytes = maxFileBytes;
  }
}

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

/** Formats a Unicode code point as `U+XXXX` without exposing the character. */
export function formatCodePoint(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * Domain error for a todo file with too many physical lines. It reports only
 * counts so an oversized file cannot be echoed back through a tool result.
 */
export class ReadTodoCountLimitError extends Error {
  readonly actualCount: number;
  readonly maxReadTodos: number;

  constructor(actualCount: number, maxReadTodos: number) {
    super(
      `Todo file contains ${actualCount} lines; the limit is ` +
        `${maxReadTodos} set by TODOTXT_MCP_MAX_READ_TODOS. ` +
        "Trim the file or raise the limit. Nothing was changed.",
    );
    this.name = "ReadTodoCountLimitError";
    this.actualCount = actualCount;
    this.maxReadTodos = maxReadTodos;
  }
}

/**
 * Domain error for a todo file line longer than the read-path ceiling. Only
 * the line number and length are exposed.
 */
export class ReadLineLengthLimitError extends Error {
  readonly lineNumber: number;
  readonly lineLength: number;
  readonly maxLineChars: number;

  constructor(lineNumber: number, lineLength: number, maxLineChars: number) {
    super(
      `Todo file line ${lineNumber} is ${lineLength} characters long; the ` +
        `limit is ${maxLineChars} set by TODOTXT_MCP_MAX_LINE_CHARS. ` +
        "Trim the line or raise the limit. Nothing was changed.",
    );
    this.name = "ReadLineLengthLimitError";
    this.lineNumber = lineNumber;
    this.lineLength = lineLength;
    this.maxLineChars = maxLineChars;
  }
}

/**
 * Domain error for a file line carrying a separator or control character.
 * The message names the line and code point only, never the line content.
 */
export class UnsafeTodoFileContentError extends Error {
  readonly lineNumber: number;
  readonly codePoint: string;

  constructor(lineNumber: number, codePoint: number) {
    const label = formatCodePoint(codePoint);
    super(
      `Todo file line ${lineNumber} contains a disallowed control character ` +
        `(${label}). Fix the file or remove the line. Nothing was changed.`,
    );
    this.name = "UnsafeTodoFileContentError";
    this.lineNumber = lineNumber;
    this.codePoint = label;
  }
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

/** Resolves the read-side line count limit (`TODOTXT_MCP_MAX_READ_TODOS`). */
export function resolveMaxReadTodos(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveIntegerEnv(
    env.TODOTXT_MCP_MAX_READ_TODOS,
    DEFAULT_MAX_READ_TODOS,
    "TODOTXT_MCP_MAX_READ_TODOS",
  );
}

/** Resolves the read-side line length limit (`TODOTXT_MCP_MAX_LINE_CHARS`). */
export function resolveMaxLineChars(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveIntegerEnv(
    env.TODOTXT_MCP_MAX_LINE_CHARS,
    DEFAULT_MAX_LINE_CHARS,
    "TODOTXT_MCP_MAX_LINE_CHARS",
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
    throw new LimitExceededError(source, byteLength, maxFileBytes);
  }
}
