import { z } from "zod";
import { BackendConflictError } from "./backend-errors.ts";
import { FileLockTimeoutError } from "./file-lock.ts";

/**
 * Stable error codes returned in `structuredContent.error.code`. Clients can
 * branch on these instead of parsing the human-readable message.
 */
export type ToolErrorCode =
  | "TODO_NOT_FOUND"
  | "INVALID_ARGUMENT"
  | "LIMIT_EXCEEDED"
  | "CONFLICT"
  | "BACKEND_ERROR";

export interface ToolErrorDetails {
  [key: string]: unknown;
}

export interface ToolErrorPayload {
  code: ToolErrorCode;
  message: string;
  details?: ToolErrorDetails;
}

/** Shape returned by every failing tool call. */
export interface ToolErrorResult {
  [key: string]: unknown;
  isError: true;
  content: Array<{ type: "text"; text: string }>;
  structuredContent: { error: ToolErrorPayload };
}

/**
 * An error carrying an explicit tool error code. Use it when a failure is
 * expected (a bad cursor, an exceeded limit) so {@link mapError} can preserve
 * the code instead of reporting `BACKEND_ERROR`.
 */
export class ToolFailure extends Error {
  readonly code: ToolErrorCode;
  readonly details: ToolErrorDetails | undefined;

  constructor(
    code: ToolErrorCode,
    message: string,
    details?: ToolErrorDetails,
  ) {
    super(message);
    this.name = "ToolFailure";
    this.code = code;
    this.details = details;
  }
}

/** Builds the canonical structured error result. */
export function toolError(
  code: ToolErrorCode,
  message: string,
  details?: ToolErrorDetails,
): ToolErrorResult {
  const error: ToolErrorPayload = { code, message };
  if (details !== undefined) {
    error.details = details;
  }

  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: { error },
  };
}

/** Standard `TODO_NOT_FOUND` result, including the refresh hint. */
export function notFoundError(hash: string): ToolErrorResult {
  return toolError(
    "TODO_NOT_FOUND",
    `Todo with hash ${hash} not found. ` +
      "Call list_todos to refresh hashes.",
    { hash, hint: "call list_todos to refresh hashes" },
  );
}

/**
 * Converts an unexpected exception into a `BACKEND_ERROR` result without
 * exposing a stack trace or a nested error's internals.
 */
export function mapError(error: unknown): ToolErrorResult {
  if (error instanceof ToolFailure) {
    return toolError(error.code, error.message, error.details);
  }

  if (error instanceof BackendConflictError) {
    return toolError("CONFLICT", error.message, {
      ...error.details,
      hint: "reload with list_todos and retry",
    });
  }

  if (error instanceof FileLockTimeoutError) {
    return toolError("CONFLICT", error.message, {
      reason: "lock-timeout",
      lockPath: error.lockPath,
      timeoutMs: error.timeoutMs,
      hint: "another writer is busy; retry the operation",
    });
  }

  if (error instanceof z.ZodError) {
    const issues = error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    const summary = issues
      .map((issue) =>
        issue.path === "" ? issue.message : `${issue.path}: ${issue.message}`
      )
      .join("; ");

    return toolError(
      "INVALID_ARGUMENT",
      summary === "" ? "Invalid arguments." : `Invalid arguments: ${summary}.`,
      { issues },
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  return toolError("BACKEND_ERROR", message);
}

/** Runs a tool operation, turning any thrown error into a structured result. */
export async function guardTool<T>(
  operation: () => Promise<T>,
): Promise<T | ToolErrorResult> {
  try {
    return await operation();
  } catch (error) {
    return mapError(error);
  }
}
