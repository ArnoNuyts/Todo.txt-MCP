import {
  ReadLineLengthLimitError,
  ReadTodoCountLimitError,
  UnsafeTodoFileContentError,
} from "./limits.ts";

/** Limits injected by the caller; this module never reads the environment. */
export interface TodoFileLimits {
  maxReadTodos: number;
  maxLineChars: number;
}

/**
 * C0 controls except tab, DEL, C1 controls, and the Unicode line/paragraph
 * separators. `\n` is the split delimiter and a single trailing `\r` is the
 * CRLF terminator, so both are handled separately by the caller.
 */
const UNSAFE_CHARACTER_PATTERN =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]/;

/**
 * Counts physical lines without allocating a substring per line. This runs
 * before `split("\n")` so a file with hundreds of thousands of lines is
 * rejected based on one scan instead of a large line array.
 */
function countPhysicalLines(data: string): number {
  let newlineCount = 0;
  let index = data.indexOf("\n");
  while (index !== -1) {
    newlineCount += 1;
    index = data.indexOf("\n", index + 1);
  }

  // A final line without a trailing newline still counts as one line.
  return data.length > 0 && !data.endsWith("\n")
    ? newlineCount + 1
    : newlineCount;
}

/**
 * Removes the single trailing `\r` that belongs to a CRLF line ending. Every
 * other `\r` is a bare carriage return and is rejected below.
 */
function withoutCrlfTerminator(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function assertLineLength(
  line: string,
  lineNumber: number,
  maxLineChars: number,
): void {
  const length = withoutCrlfTerminator(line).length;
  if (length > maxLineChars) {
    throw new ReadLineLengthLimitError(lineNumber, length, maxLineChars);
  }
}

function assertLineContentSafe(line: string, lineNumber: number): void {
  const match = UNSAFE_CHARACTER_PATTERN.exec(withoutCrlfTerminator(line));
  if (match !== null) {
    throw new UnsafeTodoFileContentError(
      lineNumber,
      match[0].codePointAt(0) ?? 0,
    );
  }
}

/**
 * Pure structural validation of decoded todo.txt content.
 *
 * Counts lines first, then splits and checks every physical line for length
 * and unsafe characters. Returns the raw lines (including blank ones) so the
 * caller can preserve untouched bytes; it performs no filesystem IO and never
 * constructs {@link Todo} objects.
 */
export function validateTodoFileContent(
  data: string,
  limits: TodoFileLimits,
): string[] {
  const actualCount = countPhysicalLines(data);
  if (actualCount > limits.maxReadTodos) {
    throw new ReadTodoCountLimitError(actualCount, limits.maxReadTodos);
  }

  const lines = data.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    assertLineLength(line, lineNumber, limits.maxLineChars);
    assertLineContentSafe(line, lineNumber);
  }

  return lines;
}
