import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import express from "express";
import type { Request, Response } from "express";
import cors from "cors";

import {
  buildCorsOptions,
  createBearerAuthMiddleware,
  DEFAULT_HOST,
  parseTrustProxy,
  type HttpSecurityOptions,
  resolveHttpSecurityOptions,
} from "./logic/http-security.ts";
import {
  type AbuseControlOverrides,
  createAbuseControls,
  resolveAbuseConfig,
} from "./logic/abuse-controls.ts";
import {
  assertAuthTokensConfigured,
  assertStrongAuthTokens,
  isWeakTokenOverrideEnabled,
  resolveAuthTokens,
  warnOnInsecureTokenFile,
} from "./logic/auth-tokens.ts";
import {
  createLogger,
  createRequestLoggingMiddleware,
  getRequestId,
  getRequestPath,
  type Logger,
  type LogLevel,
  resolveLogLevel,
} from "./logic/logging.ts";
import { createMetrics } from "./logic/metrics.ts";

import { Todo } from "./logic/todo.ts";
import {
  decodeListCursor,
  encodeListCursor,
  selectTodos,
} from "./logic/Todos.ts";
import { TodoStateEnum } from "./types/enums.ts";
import type { TodoBackend } from "./logic/backend.ts";
import { withBackendLock } from "./logic/backend-lock.ts";
import { LocalFileBackend } from "./logic/backends/local-file-backend.ts";
import { WebDavBackend } from "./logic/backends/webdav-backend.ts";
import { loadConfig } from "./logic/config.ts";
import type { TodoTxtMcpConfig } from "./logic/config.ts";
import { resolveMaxTodos, resolveMaxFileBytes } from "./logic/limits.ts";
import { createJsonContentTypeMiddleware } from "./logic/content-type.ts";
import {
  computeContentVersion,
  diffTodoContent,
  parseTodoContent,
  serializeTodoContent,
} from "./logic/content.ts";
import { summarizeTodos } from "./logic/summary.ts";
import {
  guardTool,
  isToolError,
  missingHashFailure,
  notFoundError,
  toolError,
  type BatchFailure,
  type BatchResult,
} from "./logic/tool-errors.ts";

// Schemas
export const AddTodosSchema = z.object({
  todos: z.array(z.string().max(2000)).max(100).describe(
    "The todo texts, each supports todo.txt format",
  ),
  idempotencyKey: z.string().min(1).max(128).regex(
    /^\S+$/,
    "An idempotency key must not contain whitespace",
  ).optional().describe(
    "Optional key persisted as an idem:<key> tag; repeating the same key " +
      "returns the previously added todos instead of adding them again",
  ),
  onDuplicate: z.enum(["allow", "skip", "error"]).optional().describe(
    "How to handle a todo whose normalized text already exists: 'allow' " +
      "(default) adds it, 'skip' reports it in 'skipped', 'error' fails the " +
      "whole call without writing",
  ),
});

export const UpdateTodosSchema = z.object({
  edits: z.array(z.object({
    hash: z.string().describe("Hash of the todo to edit"),
    text: z.string().max(2000).describe("New text for the todo"),
  })).max(100).describe("An array of todo edits"),
});

/** @deprecated Use {@link AddTodosSchema}. */
export const AddTodoSchema = AddTodosSchema;
/** @deprecated Use {@link UpdateTodosSchema}. */
export const EditTodoSchema = UpdateTodosSchema;

const DateOnlySchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}$/,
  "Expected a date in YYYY-MM-DD format",
).refine((value) => {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}, "Expected a valid calendar date (YYYY-MM-DD)");

export const ListTodosSchema = z.object({
  status: z.enum(["todo", "done", "all"]).optional().describe(
    "Filter by status: 'todo' (default), 'done', or 'all'",
  ),
  search: z.string().max(200).optional().describe(
    "Search query to filter todos by display text",
  ),
  context: z.string().min(1).max(100).optional().describe(
    "Only list todos in this exact context; the leading '@' is optional and " +
      "matching is case-insensitive",
  ),
  project: z.string().min(1).max(100).optional().describe(
    "Only list todos in this exact project; the leading '+' is optional and " +
      "matching is case-insensitive",
  ),
  priority: z.string().regex(
    /^[A-Z]$/,
    "Expected a single uppercase priority letter (A-Z)",
  ).optional().describe("Only list todos with this priority letter (A-Z)"),
  tag: z.record(
    z.string().min(1).max(64),
    z.string().max(500),
  ).optional().describe(
    "Only list todos matching every given key:value tag exactly",
  ),
  dueBefore: DateOnlySchema.optional().describe(
    "Only list todos whose due: date is strictly before this date " +
      "(YYYY-MM-DD)",
  ),
  createdAfter: DateOnlySchema.optional().describe(
    "Only list todos created strictly after this date (YYYY-MM-DD)",
  ),
  sort: z.enum(["creation", "completion", "priority", "text"]).optional()
    .describe(
      "Sort order: 'creation', 'completion', 'priority' or 'text' " +
        "(default: file order)",
    ),
  limit: z.number().int().min(1).max(500).optional().describe(
    "Maximum number of todos to return (default: 50)",
  ),
  offset: z.number().int().min(0).optional().describe(
    "Number of todos to skip (default: 0); ignored when 'cursor' is set",
  ),
  cursor: z.string().min(1).max(512).optional().describe(
    "Opaque cursor from a previous response's 'nextCursor'; when set, " +
      "'offset' is ignored",
  ),
  format: z.enum(["text", "structured", "both"]).optional().describe(
    "Output format: 'structured' (default) returns structured content with a " +
      "short summary line; 'text' returns only the text list; 'both' returns " +
      "both and is the most token-heavy.",
  ),
});

export const SetTodoStatusesSchema = z.object({
  hashes: z.array(z.string().min(8).max(64)).min(1).max(100).describe(
    "Hashes of the todos to update",
  ),
  status: z.enum(["done", "todo"]).describe(
    "New status for every matched todo ('done' or 'todo')",
  ),
});

export const DeleteTodosSchema = z.object({
  hashes: z.array(z.string().min(8).max(64)).min(1).max(100).describe(
    "Hashes of the todos to delete",
  ),
  dryRun: z.boolean().optional().describe(
    "When true, report what would be deleted without writing to the backend",
  ),
});

export const DeleteCompletedSchema = z.object({
  before: DateOnlySchema.optional().describe(
    "Only delete todos completed strictly before this date (YYYY-MM-DD)",
  ),
  context: z.string().min(1).max(100).optional().describe(
    "Only delete todos in this context; the leading '@' is optional and " +
      "matching is case-insensitive",
  ),
  dryRun: z.boolean().optional().describe(
    "When true, report what would be deleted without writing to the backend",
  ),
});

export const GetTodoSchema = z.object({
  hash: z.string().min(8).max(64).describe("Hash of the todo to fetch"),
});

export const SummarySchema = z.object({});

export const ExportTodosSchema = z.object({});

export const ChangesSinceSchema = z.object({
  version: z.string().min(1).max(128).describe(
    "Content version returned by a previous list_todos, get_todo, summary or " +
      "export_todos response",
  ),
});

export const ImportTodosSchema = z.object({
  content: z.string().describe(
    "todo.txt content to import, one todo per line",
  ),
  mode: z.enum(["merge", "replace"]).describe(
    "Import mode: 'merge' appends the imported todos, 'replace' overwrites " +
      "the whole file with the imported content",
  ),
  expectedVersion: z.string().min(1).max(128).optional().describe(
    "Only import when the current content version matches; a mismatch fails " +
      "with a CONFLICT error",
  ),
  dryRun: z.boolean().optional().describe(
    "When true, return the diff summary without writing to the backend",
  ),
});

/** @deprecated Use {@link SetTodoStatusesSchema} plus the deprecated single-hash shape. */
export const SetTodoStatusSchema = z.object({
  hash: z.string().describe("Hash of the todo to update"),
  status: z.enum(["done", "todo"]).describe(
    "New status for the todo ('done' or 'todo')",
  ),
});

/** @deprecated Use {@link DeleteTodosSchema} plus the deprecated single-hash shape. */
export const DeleteTodoSchema = z.object({
  hash: z.string().min(8).max(64).describe("Hash of the todo to delete"),
});

// Output schemas (raw shapes, as expected by registerTool)
const TodoSummaryShape = {
  hash: z.string(),
  text: z.string(),
  state: z.number().int(),
  status: z.enum(["todo", "done"]),
};

const TodoOutputShape = {
  ...TodoSummaryShape,
  priority: z.string().optional(),
  creationDate: z.string().optional(),
  completionDate: z.string().optional(),
};

export const ListTodosOutputShape = {
  todos: z.array(z.object(TodoOutputShape)),
  total: z.number().int(),
  nextOffset: z.number().int().nullable(),
  nextCursor: z.string().nullable(),
  version: z.string(),
};

const BatchFailureShape = z.object({
  hash: z.string(),
  code: z.enum([
    "TODO_NOT_FOUND",
    "INVALID_ARGUMENT",
    "LIMIT_EXCEEDED",
    "CONFLICT",
    "BACKEND_ERROR",
    "UNSUPPORTED",
  ]),
  message: z.string(),
});

const BatchOutputFields = {
  succeeded: z.array(z.object(TodoSummaryShape)),
  failed: z.array(BatchFailureShape),
};

const AddTodosOutputShape = {
  added: z.array(z.object(TodoSummaryShape)),
  skipped: z.array(z.object({ text: z.string(), hash: z.string() })),
};

const UpdateTodosOutputShape = {
  edited: z.array(z.object(TodoSummaryShape)),
  missing: z.array(z.string()),
  ...BatchOutputFields,
};

const DeleteTodosOutputShape = {
  deleted: z.array(z.object(TodoSummaryShape)),
  missing: z.array(z.string()),
  ...BatchOutputFields,
  dryRun: z.boolean().optional(),
};

const SetTodoStatusesOutputShape = {
  updated: z.array(z.object(TodoSummaryShape)),
  missing: z.array(z.string()),
  ...BatchOutputFields,
};

const DeleteCompletedOutputShape = {
  deletedCount: z.number().int(),
  hashes: z.array(z.string()),
  dryRun: z.boolean().optional(),
};

const GetTodoOutputShape = {
  todo: z.object(TodoOutputShape),
  version: z.string(),
};

const SummaryOutputShape = {
  version: z.string(),
  total: z.number().int(),
  open: z.number().int(),
  done: z.number().int(),
  overdue: z.number().int(),
  status: z.object({
    todo: z.number().int(),
    done: z.number().int(),
  }),
  contexts: z.record(z.string(), z.number().int()),
  projects: z.record(z.string(), z.number().int()),
  priorities: z.record(z.string(), z.number().int()),
};

const ExportTodosOutputShape = {
  content: z.string(),
  version: z.string(),
};

const ChangesSinceOutputShape = {
  changed: z.boolean(),
  version: z.string(),
  content: z.string().optional(),
};

const ImportTodosOutputShape = {
  dryRun: z.boolean(),
  mode: z.enum(["merge", "replace"]),
  changed: z.boolean(),
  version: z.string(),
  total: z.number().int(),
  importedCount: z.number().int(),
  diff: z.object({
    added: z.number().int(),
    removed: z.number().int(),
    unchanged: z.number().int(),
  }),
};

/** @deprecated Kept so the deprecated `add_todo` alias keeps its old name. */
const AddTodoOutputShape = AddTodosOutputShape;
/** @deprecated Kept so the deprecated `edit_todo` alias keeps its old name. */
const EditTodoOutputShape = UpdateTodosOutputShape;
/** Deprecated single-hash response shape for `set_todo_status`. */
const SetTodoStatusOutputShape = {
  hash: z.string(),
  status: z.enum(["done", "todo"]),
  text: z.string(),
};
/** Deprecated single-hash response shape for `delete_todo`. */
const DeleteTodoOutputShape = {
  deleted: z.literal(true),
  hash: z.string(),
};

export function createBackend(config: TodoTxtMcpConfig): TodoBackend {
  switch (config.backend) {
    case "webdav":
      return new WebDavBackend(
        config.webdav.url,
        config.webdav.username,
        config.webdav.password,
      );
    case "local":
      return new LocalFileBackend(config.local.filename);
    default: {
      const exhaustiveCheck: never = config;
      return exhaustiveCheck;
    }
  }
}

const DATE_TOKEN_REGEX = /\b\d{4}-[0-1][0-9]-[0-3][0-9]\b/g;
const IDEM_TAG_REGEX = /(?:^|\s+)idem:[^\s]+/g;

/**
 * Normalizes todo text for duplicate detection: trims, collapses whitespace,
 * lowercases, and ignores the leading `x` marker, dates, and `idem:<key>` tags.
 */
export function normalizeTodoText(text: string): string {
  return text
    .replace(IDEM_TAG_REGEX, " ")
    .replace(DATE_TOKEN_REGEX, " ")
    .replace(/^\s*x\s+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function statusOf(todo: Todo): "todo" | "done" {
  return todo.isDone() ? "done" : "todo";
}

function idempotencyKeysOf(todo: Todo): string[] {
  const value = todo.tags.idem;
  if (typeof value === "string") {
    return [value];
  }
  return Array.isArray(value) ? value : [];
}

async function summarizeTodo(todo: Todo) {
  return {
    hash: await todo.getHash(),
    text: todo.toDisplayString(),
    state: todo.state,
    status: statusOf(todo),
  };
}

async function summarizeTodoDetail(todo: Todo) {
  return {
    ...await summarizeTodo(todo),
    priority: todo.priority,
    creationDate: todo.creationDate?.toISOString().substring(0, 10),
    completionDate: todo.completionDate?.toISOString().substring(0, 10),
  };
}

/** Shared `succeeded`/`failed` fields for partially successful batches. */
function batchFields(
  succeeded: Awaited<ReturnType<typeof summarizeTodo>>[],
  missing: string[],
): BatchResult<Awaited<ReturnType<typeof summarizeTodo>>> {
  const failed: BatchFailure[] = missing.map(missingHashFailure);
  return { succeeded, failed };
}

function todoHasContext(todo: Todo, context: string): boolean {
  for (const todoContext of todo.contexts) {
    if (todoContext.toLowerCase() === context) {
      return true;
    }
  }
  // The parser only recognizes contexts preceded by whitespace, so also check
  // the raw text with an explicit start anchor.
  const escaped = context.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)@${escaped}(?=$|\\s)`, "i").test(todo.text);
}

// Tool: add_todos handler
async function addTodosOperation(
  backend: TodoBackend,
  rawArgs: unknown,
) {
  const {
    todos: todoTexts,
    idempotencyKey,
    onDuplicate = "allow",
  } = AddTodosSchema.parse(rawArgs);

  return await withBackendLock(backend, async () => {
    const todos = await backend.load();

    // A repeated idempotency key replays the previously added todos instead of
    // adding them again.
    if (idempotencyKey !== undefined) {
      const previous = todos.filter((todo) =>
        idempotencyKeysOf(todo).includes(idempotencyKey)
      );
      if (previous.length > 0) {
        const added = await Promise.all(previous.map(summarizeTodo));
        return {
          content: [{
            type: "text" as const,
            text: added.map(({ hash, text }) => `Added todo [${hash}]: ${text}`)
              .join("\n"),
          }],
          structuredContent: { added, skipped: [] },
        };
      }
    }

    const existingByText = new Map<string, Todo>();
    for (const todo of todos) {
      const key = normalizeTodoText(todo.toString());
      if (!existingByText.has(key)) {
        existingByText.set(key, todo);
      }
    }

    const toAdd: Todo[] = [];
    const skipped: Array<{ text: string; hash: string }> = [];
    const duplicates: string[] = [];
    // Tracks texts added earlier in this same call so a request cannot sneak
    // duplicates past the onDuplicate policy.
    const seenInRequest = new Map<string, Todo>();

    for (const text of todoTexts) {
      const key = normalizeTodoText(text);
      const newTodo = new Todo(text);
      if (!newTodo.creationDate) {
        newTodo.creationDate = new Date();
      }
      if (idempotencyKey !== undefined) {
        newTodo.tags.idem = idempotencyKey;
      }

      const existing = existingByText.get(key);
      const earlierInRequest = seenInRequest.get(key);
      if (existing || earlierInRequest) {
        if (onDuplicate === "skip") {
          skipped.push({
            text,
            hash: await (existing ?? earlierInRequest!).getHash(),
          });
          continue;
        }
        if (onDuplicate === "error") {
          duplicates.push(text);
          continue;
        }
      }

      if (!seenInRequest.has(key)) {
        seenInRequest.set(key, newTodo);
      }
      toAdd.push(newTodo);
    }

    if (onDuplicate === "error" && duplicates.length > 0) {
      return toolError(
        "CONFLICT",
        `Cannot add ${duplicates.length} duplicate todo(s) ` +
          `(onDuplicate: "error"): ${duplicates.join(", ")}. ` +
          `Nothing was saved.`,
        { duplicates },
      );
    }

    // Enforce the total-size cap before mutating anything so a rejected add
    // never partially writes to the backend.
    const maxTodos = resolveMaxTodos();
    if (todos.length + toAdd.length > maxTodos) {
      return toolError(
        "LIMIT_EXCEEDED",
        `Cannot add ${toAdd.length} todo(s): the file already ` +
          `contains ${todos.length} and the limit is ${maxTodos} todos ` +
          `(TODOTXT_MCP_MAX_TODOS). Nothing was saved.`,
        {
          maxTodos,
          currentCount: todos.length,
          requestedCount: toAdd.length,
        },
      );
    }

    for (const todo of toAdd) {
      todos.push(todo);
    }
    if (toAdd.length > 0) {
      await backend.save(todos);
    }

    const added = await Promise.all(toAdd.map(summarizeTodo));
    const resultLines = [
      ...added.map(({ hash, text }) => `Added todo [${hash}]: ${text}`),
      ...skipped.map(({ text }) => `Skipped duplicate todo: ${text}`),
    ];

    return {
      content: [{
        type: "text" as const,
        text: resultLines.length > 0
          ? resultLines.join("\n")
          : "No todos were added.",
      }],
      structuredContent: { added, skipped },
    };
  });
}

export function addTodosHandler(backend: TodoBackend, rawArgs: unknown) {
  return guardTool(() => addTodosOperation(backend, rawArgs));
}

/** @deprecated Use {@link addTodosHandler}; kept for the `add_todo` alias. */
export const addTodoHandler = addTodosHandler;

async function updateTodosOperation(
  backend: TodoBackend,
  rawArgs: unknown,
) {
  const { edits } = UpdateTodosSchema.parse(rawArgs);

  return await withBackendLock(backend, async () => {
    const todos = await backend.load();
    const results: string[] = [];
    const edited: Awaited<ReturnType<typeof summarizeTodo>>[] = [];
    const missing: string[] = [];
    let changesMade = false;

    const todoHashMap = new Map<string, Todo>();
    for (const todo of todos) {
      todoHashMap.set(await todo.getHash(), todo);
    }

    for (const edit of edits) {
      const { hash, text } = edit;
      const todo = todoHashMap.get(hash);

      if (todo) {
        todo.setText(text);
        const summary = await summarizeTodo(todo);
        edited.push(summary);
        results.push(`Edited todo [${summary.hash}]: ${summary.text}`);
        changesMade = true;
      } else {
        missing.push(hash);
        results.push(`Todo with hash ${hash} not found.`);
      }
    }

    if (changesMade) {
      await backend.save(todos);
    }

    return {
      content: [
        {
          type: "text" as const,
          text: results.join("\n"),
        },
      ],
      structuredContent: {
        edited,
        missing,
        ...batchFields(edited, missing),
      },
    };
  });
}

export function updateTodosHandler(backend: TodoBackend, rawArgs: unknown) {
  return guardTool(() => updateTodosOperation(backend, rawArgs));
}

/** @deprecated Use {@link updateTodosHandler}; kept for the `edit_todo` alias. */
export const editTodoHandler = updateTodosHandler;

async function listTodosOperation(
  backend: TodoBackend,
  rawArgs: unknown,
) {
  const args = ListTodosSchema.parse(rawArgs);
  const { limit = 50, offset = 0, cursor, format = "structured" } = args;
  const allTodos = await backend.load();
  const version = computeContentVersion(allTodos);

  // Status, search, context, project, priority, tag and date filters all
  // combine with AND. Sorting preserves file order by default.
  const filteredTodos = selectTodos(allTodos, {
    ...args,
    status: args.status ?? "todo",
  });

  // A cursor is an opaque offset. When present it wins over `offset`, which
  // stays supported for clients that have not migrated yet.
  const start = cursor === undefined ? offset : decodeListCursor(cursor);
  const pagedTodos = filteredTodos.slice(start, start + limit);

  const todoEntries = await Promise.all(
    pagedTodos.map(summarizeTodoDetail),
  );

  const todoStrings = todoEntries.map(({ hash, text }) =>
    `[${hash}] ${text}`
  );

  const nextOffset = start + pagedTodos.length < filteredTodos.length
    ? start + pagedTodos.length
    : null;
  const nextCursor = nextOffset === null
    ? null
    : encodeListCursor(nextOffset);

  const structuredContent = {
    todos: todoEntries,
    total: filteredTodos.length,
    nextOffset,
    nextCursor,
    version,
  };

  const text = todoStrings.length > 0
    ? todoStrings.join("\n")
    : "No todos found matching criteria.";

  if (format === "text") {
    return {
      content: [{ type: "text" as const, text }],
    };
  }

  if (format === "structured") {
    return {
      content: [{ type: "text" as const, text: `${filteredTodos.length} todos` }],
      structuredContent,
    };
  }

  return {
    content: [{ type: "text" as const, text }],
    structuredContent,
  };
}

export function listTodosHandler(backend: TodoBackend, rawArgs: unknown) {
  return guardTool(() => listTodosOperation(backend, rawArgs));
}

// Tool: set_todo_statuses handler
async function setTodoStatusesOperation(
  backend: TodoBackend,
  rawArgs: unknown,
) {
  const { hashes, status } = SetTodoStatusesSchema.parse(rawArgs);

  return await withBackendLock(backend, async () => {
    const todos = await backend.load();

    const todoHashMap = new Map<string, Todo>();
    for (const todo of todos) {
      todoHashMap.set(await todo.getHash(), todo);
    }

    const targetState = status === "done"
      ? TodoStateEnum.done
      : TodoStateEnum.todo;

    const updated: Awaited<ReturnType<typeof summarizeTodo>>[] = [];
    const missing: string[] = [];
    const results: string[] = [];
    let changesMade = false;

    for (const hash of new Set(hashes)) {
      const todo = todoHashMap.get(hash);

      if (!todo) {
        missing.push(hash);
        results.push(`Todo with hash ${hash} not found.`);
        continue;
      }

      if (todo.state !== targetState) {
        const newTodo = todo.toggleState();
        if (newTodo) {
          todos.push(newTodo);
        }
        changesMade = true;
      }

      const summary = await summarizeTodo(todo);
      updated.push(summary);
      results.push(
        `Set todo [${summary.hash}] status to ${status}: ${summary.text}`,
      );
    }

    if (changesMade) {
      await backend.save(todos);
    }

    return {
      content: [
        {
          type: "text" as const,
          text: results.length > 0
            ? results.join("\n")
            : "No matching todos found.",
        },
      ],
      structuredContent: {
        updated,
        missing,
        ...batchFields(updated, missing),
      },
    };
  });
}

export function setTodoStatusesHandler(
  backend: TodoBackend,
  rawArgs: unknown,
) {
  return guardTool(() => setTodoStatusesOperation(backend, rawArgs));
}

/** @deprecated Use {@link setTodoStatusesHandler}; kept for the alias. */
export async function setTodoStatusHandler(
  backend: TodoBackend,
  rawArgs: unknown,
) {
  return guardTool(async () => {
    const { hash, status } = SetTodoStatusSchema.parse(rawArgs);
    const result = await setTodoStatusesHandler(backend, {
      hashes: [hash],
      status,
    });

    if (isToolError(result)) {
      return result;
    }

    const updated = result.structuredContent.updated[0];
    if (updated === undefined) {
      return notFoundError(hash);
    }

    return {
      content: [{
        type: "text" as const,
        text: `Set todo [${updated.hash}] status to ${status}: ${updated.text}`,
      }],
      structuredContent: {
        hash: updated.hash,
        status,
        text: updated.text,
      },
    };
  });
}

// Tool: delete_todos handler
async function deleteTodosOperation(
  backend: TodoBackend,
  rawArgs: unknown,
) {
  const { hashes, dryRun = false } = DeleteTodosSchema.parse(rawArgs);

  return await withBackendLock(backend, async () => {
    const todos = await backend.load();

    const todoHashMap = new Map<string, Todo>();
    for (const todo of todos) {
      todoHashMap.set(await todo.getHash(), todo);
    }

    const deleted: Awaited<ReturnType<typeof summarizeTodo>>[] = [];
    const missing: string[] = [];
    const toDelete = new Set<Todo>();

    for (const hash of new Set(hashes)) {
      const todo = todoHashMap.get(hash);
      if (todo === undefined) {
        missing.push(hash);
        continue;
      }
      toDelete.add(todo);
      deleted.push(await summarizeTodo(todo));
    }

    // Nothing matched (or this is a dry run): leave the backend untouched.
    if (toDelete.size > 0 && !dryRun) {
      await backend.save(todos.filter((todo) => !toDelete.has(todo)));
    }

    const results = [
      ...deleted.map(({ hash, text }) =>
        dryRun
          ? `Would delete todo [${hash}]: ${text}`
          : `Deleted todo [${hash}]: ${text}`
      ),
      ...missing.map((hash) => `Todo with hash ${hash} not found.`),
    ];

    return {
      content: [{
        type: "text" as const,
        text: results.length > 0
          ? results.join("\n")
          : dryRun
          ? "No matching todos found. Nothing would be deleted."
          : "No matching todos found. Nothing was deleted.",
      }],
      structuredContent: {
        deleted,
        missing,
        ...batchFields(deleted, missing),
        ...(dryRun ? { dryRun: true } : {}),
      },
    };
  });
}

export function deleteTodosHandler(backend: TodoBackend, rawArgs: unknown) {
  return guardTool(() => deleteTodosOperation(backend, rawArgs));
}

/** @deprecated Use {@link deleteTodosHandler}; kept for the `delete_todo` alias. */
export async function deleteTodoHandler(
  backend: TodoBackend,
  rawArgs: unknown,
) {
  return guardTool(async () => {
    const { hash } = DeleteTodoSchema.parse(rawArgs);
    const result = await deleteTodosHandler(backend, { hashes: [hash] });

    if (isToolError(result)) {
      return result;
    }

    if (result.structuredContent.deleted.length === 0) {
      return notFoundError(hash);
    }

    return {
      content: [{
        type: "text" as const,
        text: `Deleted todo [${hash}]`,
      }],
      structuredContent: { deleted: true as const, hash },
    };
  });
}

// Tool: delete_completed handler
async function deleteCompletedOperation(
  backend: TodoBackend,
  rawArgs: unknown,
) {
  const { before, context, dryRun = false } = DeleteCompletedSchema.parse(
    rawArgs,
  );
  const normalizedContext = context?.replace(/^@/, "").toLowerCase();
  const beforeTime = before === undefined
    ? undefined
    : new Date(`${before}T00:00:00.000Z`).getTime();

  return await withBackendLock(backend, async () => {
    const todos = await backend.load();
    const remaining: Todo[] = [];
    const hashes: string[] = [];

    for (const todo of todos) {
      const completedBefore = beforeTime === undefined ||
        (todo.completionDate !== undefined &&
          todo.completionDate.getTime() < beforeTime);
      const inContext = normalizedContext === undefined ||
        todoHasContext(todo, normalizedContext);

      if (todo.isDone() && completedBefore && inContext) {
        hashes.push(await todo.getHash());
      } else {
        remaining.push(todo);
      }
    }

    if (hashes.length > 0 && !dryRun) {
      await backend.save(remaining);
    }

    const action = dryRun ? "Would delete" : "Deleted";
    const text = hashes.length > 0
      ? `${action} ${hashes.length} completed todo(s):\n` +
        hashes.map((hash) => `[${hash}]`).join("\n")
      : dryRun
      ? "No completed todos matched. Nothing would be deleted."
      : "No completed todos matched. Nothing was deleted.";

    return {
      content: [{
        type: "text" as const,
        text,
      }],
      structuredContent: {
        deletedCount: hashes.length,
        hashes,
        ...(dryRun ? { dryRun: true } : {}),
      },
    };
  });
}

export function deleteCompletedHandler(
  backend: TodoBackend,
  rawArgs: unknown,
) {
  return guardTool(() => deleteCompletedOperation(backend, rawArgs));
}

// Tool: get_todo handler
async function getTodoOperation(backend: TodoBackend, rawArgs: unknown) {
  const { hash } = GetTodoSchema.parse(rawArgs);
  const todos = await backend.load();
  const version = computeContentVersion(todos);

  for (const todo of todos) {
    if (await todo.getHash() === hash) {
      const summary = await summarizeTodoDetail(todo);
      return {
        content: [{
          type: "text" as const,
          text: `[${hash}] ${summary.text}`,
        }],
        structuredContent: { todo: summary, version },
      };
    }
  }

  return notFoundError(hash);
}

export function getTodoHandler(backend: TodoBackend, rawArgs: unknown) {
  return guardTool(() => getTodoOperation(backend, rawArgs));
}

// Tool: summary handler
async function summaryOperation(backend: TodoBackend, rawArgs: unknown) {
  SummarySchema.parse(rawArgs ?? {});
  const todos = await backend.load();
  const version = computeContentVersion(todos);
  const report = summarizeTodos(todos);

  const lines = [
    `${report.total} todos (${report.open} open, ${report.done} done, ` +
    `${report.overdue} overdue)`,
  ];
  for (const [label, counts] of [
    ["Contexts", report.contexts],
    ["Projects", report.projects],
    ["Priorities", report.priorities],
  ] as const) {
    const entries = Object.entries(counts);
    if (entries.length > 0) {
      lines.push(
        `${label}: ${
          entries.map(([name, count]) => `${name}=${count}`).join(", ")
        }`,
      );
    }
  }

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    structuredContent: { version, ...report },
  };
}

export function summaryHandler(backend: TodoBackend, rawArgs: unknown) {
  return guardTool(() => summaryOperation(backend, rawArgs));
}

// Tool: export_todos handler
async function exportTodosOperation(backend: TodoBackend, rawArgs: unknown) {
  ExportTodosSchema.parse(rawArgs ?? {});
  const todos = await backend.load();
  const content = serializeTodoContent(todos);
  const version = computeContentVersion(todos);

  return {
    content: [{ type: "text" as const, text: content }],
    structuredContent: { content, version },
  };
}

export function exportTodosHandler(backend: TodoBackend, rawArgs: unknown) {
  return guardTool(() => exportTodosOperation(backend, rawArgs));
}

// Tool: changes_since handler
async function changesSinceOperation(backend: TodoBackend, rawArgs: unknown) {
  const { version } = ChangesSinceSchema.parse(rawArgs);
  const todos = await backend.load();
  const currentVersion = computeContentVersion(todos);

  if (currentVersion === version) {
    return {
      content: [{
        type: "text" as const,
        text: `No changes since version ${version}.`,
      }],
      structuredContent: { changed: false, version: currentVersion },
    };
  }

  return {
    content: [{
      type: "text" as const,
      text: `Todo file changed. Current version: ${currentVersion}.`,
    }],
    structuredContent: {
      changed: true,
      version: currentVersion,
      content: serializeTodoContent(todos),
    },
  };
}

export function changesSinceHandler(backend: TodoBackend, rawArgs: unknown) {
  return guardTool(() => changesSinceOperation(backend, rawArgs));
}

/**
 * Merges imported todos into the current list without duplicating items that
 * already exist (by normalized text). Duplicates inside the imported payload
 * are collapsed too, keeping the first occurrence.
 */
export function mergeTodoLists(current: Todo[], imported: Todo[]): Todo[] {
  const seen = new Set(current.map((todo) => normalizeTodoText(todo.toString())));
  const additions = imported.filter((todo) => {
    const key = normalizeTodoText(todo.toString());
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  return [...current, ...additions];
}

// Tool: import_todos handler
async function importTodosOperation(backend: TodoBackend, rawArgs: unknown) {
  const {
    content,
    mode,
    expectedVersion,
    dryRun = false,
  } = ImportTodosSchema.parse(rawArgs);

  const maxFileBytes = resolveMaxFileBytes();
  const byteLength = Buffer.byteLength(content, "utf8");
  if (byteLength > maxFileBytes) {
    return toolError(
      "LIMIT_EXCEEDED",
      `Cannot import ${byteLength} bytes: the limit is ${maxFileBytes} ` +
        `bytes (TODOTXT_MCP_MAX_FILE_BYTES). Nothing was saved.`,
      { byteLength, maxFileBytes },
    );
  }

  const imported = parseTodoContent(content);
  const maxTodos = resolveMaxTodos();
  if (imported.length > maxTodos) {
    return toolError(
      "LIMIT_EXCEEDED",
      `Cannot import ${imported.length} todo(s): the limit is ${maxTodos} ` +
        `todos (TODOTXT_MCP_MAX_TODOS). Nothing was saved.`,
      { count: imported.length, maxTodos },
    );
  }

  return await withBackendLock(backend, async () => {
    const current = await backend.load();
    const currentVersion = computeContentVersion(current);

    if (
      expectedVersion !== undefined && expectedVersion !== currentVersion
    ) {
      return toolError(
        "CONFLICT",
        `Version conflict: expected ${expectedVersion} but the current ` +
          `version is ${currentVersion}. Nothing was imported.`,
        { expectedVersion, currentVersion },
      );
    }

    const next = mode === "replace" ? imported : mergeTodoLists(current, imported);
    if (next.length > maxTodos) {
      return toolError(
        "LIMIT_EXCEEDED",
        `Cannot import: the result would contain ${next.length} todo(s), ` +
          `which exceeds the limit of ${maxTodos} (TODOTXT_MCP_MAX_TODOS). ` +
          `Nothing was saved.`,
        { count: next.length, maxTodos },
      );
    }

    const diff = diffTodoContent(current, next);
    const changed = diff.added > 0 || diff.removed > 0;

    if (changed && !dryRun) {
      await backend.save(next);
    }

    const text = dryRun
      ? `Dry run (${mode}): would add ${diff.added}, remove ${diff.removed}, ` +
        `keep ${diff.unchanged} unchanged todo(s). Nothing was saved.`
      : changed
      ? `Imported content (${mode}): added ${diff.added}, ` +
        `removed ${diff.removed}, unchanged ${diff.unchanged}.`
      : `No changes: imported content matches the current todos.`;

    return {
      content: [{ type: "text" as const, text }],
      structuredContent: {
        dryRun,
        mode,
        changed,
        version: dryRun ? currentVersion : computeContentVersion(next),
        total: next.length,
        importedCount: imported.length,
        diff,
      },
    };
  });
}

export function importTodosHandler(backend: TodoBackend, rawArgs: unknown) {
  return guardTool(() => importTodosOperation(backend, rawArgs));
}

export type TodoToolset = "full" | "core" | "readonly" | "off";

export interface CreateTodoMcpServerOptions {
  /** When true only `list_todos` is exposed; mutating tools are absent. */
  readOnly?: boolean;
  /** Expose coarse tool profiles; `off` exposes resources only. */
  toolset?: TodoToolset;
  /**
   * Include `outputSchema` in `tools/list`. Off by default: output schemas are
   * roughly half of the tool-definition payload and most clients do not
   * validate them.
   */
  outputSchemas?: boolean;
}

/**
 * Resolves read-only mode from an explicit option, then `MCP_READ_ONLY`.
 * Accepts `1`, `true`, or `yes` (case-insensitive).
 */
export function resolveReadOnlyMode(
  options: { readOnly?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (options.readOnly !== undefined) {
    return options.readOnly;
  }
  const value = env.MCP_READ_ONLY?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/**
 * Resolves the exposed toolset from an explicit option, then `MCP_TOOLSET`.
 * Unknown values fall back to `full` so a typo cannot silently remove tools.
 */
export function resolveToolset(
  options: { toolset?: TodoToolset } = {},
  env: NodeJS.ProcessEnv = process.env,
): TodoToolset {
  if (options.toolset !== undefined) {
    return options.toolset;
  }
  const value = env.MCP_TOOLSET?.trim().toLowerCase();
  if (value === "full" || value === "core" || value === "readonly" || value === "off") {
    return value;
  }
  return "full";
}

/**
 * Resolves output-schema exposure from an explicit option, then
 * `MCP_OUTPUT_SCHEMAS`. Off by default; enable with `1`, `true`, or `yes`.
 */
export function resolveOutputSchemas(
  options: { outputSchemas?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (options.outputSchemas !== undefined) {
    return options.outputSchemas;
  }
  const value = env.MCP_OUTPUT_SCHEMAS?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export function createTodoMcpServer(
  backend: TodoBackend,
  options: CreateTodoMcpServerOptions = {},
) {
  const toolset = resolveToolset(options);
  const exposeOutputSchemas = resolveOutputSchemas(options);
  const outputSchema = (shape: Record<string, z.ZodTypeAny>) =>
    exposeOutputSchemas ? { outputSchema: shape } : {};

  const server = new McpServer({
    name: "todo.txt-mcp",
    version: "2.1.0",
  });

  // Register a prompt describing the todo.txt format
  server.registerPrompt(
    "todo_format",
    {
      description:
        "The todo.txt format includes tags (e.g., @home), contexts (e.g., +project), recurrence rec:+2w (e.g., 'every 2 weeks'), and the 'x' marker indicating a completed task.",
    },
    () => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text:
            "todo.txt is a plain-text task format with one task per line.\n\n" +
            "- A completed task starts with `x ` (e.g. `x 2024-06-02 Buy milk`).\n" +
            "- A priority is a single uppercase letter in parentheses at the start: `(A)` to `(Z)`.\n" +
            "- A creation date and (for completed tasks) a completion date use the `YYYY-MM-DD` format.\n" +
            "- Projects are written as `+project` and contexts as `@context`.\n" +
            "- Free-form `key:value` tags are allowed. Useful ones include `due:YYYY-MM-DD`, `t:YYYY-MM-DD` (threshold) and `rec:+2w` / `rec:1m` style recurrence rules for repeating tasks.\n\n" +
            "Example:\n" +
            "(A) 2024-06-01 Pay rent +home due:2024-06-30\n" +
            "x 2024-06-02 2024-06-01 Call the dentist @phone rec:+1m",
        },
      }],
    }),
  );

  // Read-only MCP resources. They always load through the backend and never
  // mutate it, so they are available in read-only mode too.
  const textResource = (uri: URL, text: string) => ({
    contents: [{ uri: uri.href, mimeType: "text/plain" as const, text }],
  });

  server.registerResource(
    "todo-file",
    "todo://file",
    {
      title: "todo.txt",
      description: "The complete todo.txt file.",
      mimeType: "text/plain",
    },
    async (uri) => {
      const todos = await backend.load();
      return textResource(uri, serializeTodoContent(todos));
    },
  );

  server.registerResource(
    "todo-active",
    "todo://active",
    {
      title: "Active todos",
      description: "Open todos only, one per line.",
      mimeType: "text/plain",
    },
    async (uri) => {
      const todos = await backend.load();
      return textResource(
        uri,
        serializeTodoContent(todos.filter((todo) => !todo.isDone())),
      );
    },
  );

  server.registerResource(
    "todo-context",
    new ResourceTemplate("todo://context/{name}", { list: undefined }),
    {
      title: "Todos in a context",
      description: "Open todos in one @context, one per line.",
      mimeType: "text/plain",
    },
    async (uri, variables) => {
      const rawName = String(variables.name ?? "");
      let context = rawName;
      try {
        context = decodeURIComponent(rawName);
      } catch {
        // Keep the raw value when it is not valid percent-encoding.
      }
      const todos = await backend.load();
      const normalized = context.replace(/^@/, "").toLowerCase();
      const matching = todos.filter((todo) =>
        !todo.isDone() && todoHasContext(todo, normalized)
      );
      return textResource(uri, serializeTodoContent(matching));
    },
  );

  if (toolset === "off") {
    return server;
  }

  // Tool: list_todos
  // No `outputSchema` is declared: the `format: "text"` mode returns no
  // structured content, which the MCP SDK rejects when an output schema is
  // present. Default ("structured") and "both" responses still include
  // structured content matching `ListTodosOutputShape`.
  server.registerTool(
    "list_todos",
    {
      description:
        "List todos with optional status, search, context, project, priority, " +
        "tag, date, sort, limit, offset, and cursor filters. Responses include " +
        "the current content version.",
      inputSchema: ListTodosSchema.shape,
      annotations: { readOnlyHint: true },
    },
    (rawArgs: unknown) => listTodosHandler(backend, rawArgs),
  );

  // Read-only mode exposes listing only. Returning here keeps the mutating
  // tools out of tools/list and out of the callable surface entirely.
  if (options.readOnly === true) {
    return server;
  }

  if (toolset !== "readonly") {
    // Tool: add_todos
    server.registerTool(
      "add_todos",
      {
        description:
          "Add one or more todos in todo.txt format. Supports duplicate " +
          "handling and an idempotency key for safe retries.",
        inputSchema: AddTodosSchema.shape,
        ...outputSchema(AddTodosOutputShape),
        annotations: {
          destructiveHint: false,
          idempotentHint: false,
        },
      },
      (rawArgs: unknown) => addTodosHandler(backend, rawArgs),
    );

    // Tool: update_todos
    server.registerTool(
      "update_todos",
      {
        description: "Edit one or more existing todos by hash.",
        inputSchema: UpdateTodosSchema.shape,
        ...outputSchema(UpdateTodosOutputShape),
        annotations: {
          destructiveHint: true,
          idempotentHint: false,
        },
      },
      (rawArgs: unknown) => updateTodosHandler(backend, rawArgs),
    );

    // Tool: set_todo_statuses
    server.registerTool(
      "set_todo_statuses",
      {
        description:
          "Mark todos done or active by hash. Loads and saves the backend once " +
          "for the whole batch.",
        inputSchema: SetTodoStatusesSchema.shape,
        ...outputSchema(SetTodoStatusesOutputShape),
        annotations: {
          destructiveHint: true,
          idempotentHint: true,
        },
      },
      (rawArgs: unknown) => setTodoStatusesHandler(backend, rawArgs),
    );

    // Tool: delete_todos
    server.registerTool(
      "delete_todos",
      {
        description:
          "Delete todos by hash in one batch. Loads and saves the backend once. " +
          "Pass dryRun to preview the deletion without writing.",
        inputSchema: DeleteTodosSchema.shape,
        ...outputSchema(DeleteTodosOutputShape),
        annotations: {
          destructiveHint: true,
          idempotentHint: true,
        },
      },
      (rawArgs: unknown) => deleteTodosHandler(backend, rawArgs),
    );
  }

  if (toolset === "full") {
    // Tool: delete_completed
    server.registerTool(
      "delete_completed",
      {
        description:
          "Delete completed todos, optionally only those completed before a " +
          "date and/or in a context. Pass dryRun to preview without writing.",
        inputSchema: DeleteCompletedSchema.shape,
        ...outputSchema(DeleteCompletedOutputShape),
        annotations: {
          destructiveHint: true,
          idempotentHint: true,
        },
      },
      (rawArgs: unknown) => deleteCompletedHandler(backend, rawArgs),
    );
  }

  // Tool: get_todo
  server.registerTool(
    "get_todo",
    {
      description:
        "Fetch a single todo by hash, including its content version.",
      inputSchema: GetTodoSchema.shape,
      ...outputSchema(GetTodoOutputShape),
      annotations: { readOnlyHint: true },
    },
    (rawArgs: unknown) => getTodoHandler(backend, rawArgs),
  );

  // Tool: summary
  server.registerTool(
    "summary",
    {
      description:
        "Summarize todo counts by status, context, project and priority, " +
        "plus the number of overdue open todos.",
      inputSchema: SummarySchema.shape,
      ...outputSchema(SummaryOutputShape),
      annotations: { readOnlyHint: true },
    },
    (rawArgs: unknown) => summaryHandler(backend, rawArgs),
  );

  // Tool: export_todos
  server.registerTool(
    "export_todos",
    {
      description:
        "Export the whole todo.txt content together with its content version.",
      inputSchema: ExportTodosSchema.shape,
      ...outputSchema(ExportTodosOutputShape),
      annotations: { readOnlyHint: true },
    },
    (rawArgs: unknown) => exportTodosHandler(backend, rawArgs),
  );

  // Tool: changes_since
  server.registerTool(
    "changes_since",
    {
      description:
        "Report whether the todo file changed since a version. When it did, " +
        "the current content is included.",
      inputSchema: ChangesSinceSchema.shape,
      ...outputSchema(ChangesSinceOutputShape),
      annotations: { readOnlyHint: true },
    },
    (rawArgs: unknown) => changesSinceHandler(backend, rawArgs),
  );

  if (toolset === "full") {
    // Tool: import_todos
    server.registerTool(
      "import_todos",
      {
        description:
          "Import todo.txt content in merge or replace mode, optionally guarded " +
          "by an expected content version. Supports a dry run diff.",
        inputSchema: ImportTodosSchema.shape,
        ...outputSchema(ImportTodosOutputShape),
        annotations: {
          destructiveHint: true,
          idempotentHint: false,
        },
      },
      (rawArgs: unknown) => importTodosHandler(backend, rawArgs),
    );
  }

  return server;
}

export type CreateAppOptions = HttpSecurityOptions & {
  abuse?: AbuseControlOverrides;
  trustProxy?: string | number | boolean | string[];
  /** When true only `list_todos` is registered on the MCP endpoint. */
  readOnly?: boolean;
  /** Injectable structured logger, primarily for tests. */
  logger?: Logger;
  /** Overrides `MCP_LOG_LEVEL` for the default logger. */
  logLevel?: LogLevel;
  /** Overrides `MCP_TOOLSET` for the exposed tool profile. */
  toolset?: TodoToolset;
  /** Overrides `MCP_OUTPUT_SCHEMAS`; off by default. */
  outputSchemas?: boolean;
};

export function createApp(
  backend: TodoBackend,
  options: CreateAppOptions = {},
) {
  const { allowedHosts, allowedOrigins, authTokens } =
    resolveHttpSecurityOptions(options);
  const abuseOverrides = options.abuse ?? {};
  const abuseConfig = resolveAbuseConfig(process.env, abuseOverrides);
  const abuse = createAbuseControls(abuseConfig, abuseOverrides.now);
  const logger = options.logger ??
    createLogger({ level: options.logLevel ?? resolveLogLevel(process.env) });
  const metrics = createMetrics();
  const readOnly = resolveReadOnlyMode(options, process.env);
  const toolset = resolveToolset(options, process.env);
  const outputSchemas = resolveOutputSchemas(options, process.env);
  const app = express();

  // Do not advertise the framework.
  app.disable("x-powered-by");

  // An empty allowlist means "no browser origins allowed". The transport
  // skips Origin validation when the list is empty, so pass a sentinel that
  // no real Origin can match to keep the behavior fail-closed.
  const transportOrigins = allowedOrigins.length > 0
    ? allowedOrigins
    : ["__no_origins_allowed__"];

  // Only opt into proxy headers when explicitly configured. Trusting
  // X-Forwarded-For without a real proxy lets clients spoof their limiter key.
  const trustProxy = parseTrustProxy(
    options.trustProxy ?? process.env.TRUST_PROXY,
  );
  if (trustProxy !== undefined) {
    app.set("trust proxy", trustProxy);
  }

  // Assign/echo a request ID and log one structured line per request. This
  // never includes Authorization, tokens, bodies, or todo content.
  app.use(createRequestLoggingMiddleware(logger));

  // Count every finished response, including health checks and rejections.
  app.use((_req: Request, res: Response, next) => {
    res.once("finish", () => metrics.recordRequest(res.statusCode));
    next();
  });

  // Security headers for the data-bearing endpoints.
  const securityHeaders = (
    _req: Request,
    res: Response,
    next: () => void,
  ) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    next();
  };
  app.use("/mcp", securityHeaders);
  app.use("/metrics", securityHeaders);

  // Port-agnostic Host validation protects against DNS rebinding.
  app.use(hostHeaderValidation(allowedHosts));

  // Never emit CORS headers when no origins are explicitly allowed.
  if (allowedOrigins.length > 0) {
    app.use(cors(buildCorsOptions(allowedOrigins)));
  }

  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  // Abuse controls run before authentication so floods and banned keys are
  // rejected without doing token work. Health checks are never affected.
  app.use("/mcp", (req: Request, res: Response, next) => {
    const key = abuse.clientKey(req);

    const breaker = abuse.breaker.state();
    if (breaker.open) {
      logger.warn("auth_failure_circuit_open", {
        requestId: getRequestId(req),
        ip: req.ip ?? "unknown",
        retryAfterSec: breaker.retryAfterSec,
      });
      res.setHeader("Retry-After", String(breaker.retryAfterSec));
      res.status(503).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Service temporarily unavailable due to authentication failures.",
        },
        id: null,
      });
      return;
    }

    const ban = abuse.authFailures.getBan(key);
    if (ban.banned) {
      logger.warn("auth_banned", {
        requestId: getRequestId(req),
        ip: req.ip ?? "unknown",
        retryAfterSec: ban.retryAfterSec,
      });
      res.setHeader("Retry-After", String(ban.retryAfterSec));
      res.status(429).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Too many failed authentication attempts.",
        },
        id: null,
      });
      return;
    }

    const limit = abuse.limiter.check(key);
    if (limit.limit > 0) {
      res.setHeader("RateLimit-Limit", String(limit.limit));
      res.setHeader("RateLimit-Remaining", String(limit.remaining));
      res.setHeader("RateLimit-Reset", String(limit.resetAfterSec));
    }
    if (!limit.allowed) {
      logger.warn("rate_limited", {
        requestId: getRequestId(req),
        ip: req.ip ?? "unknown",
        retryAfterSec: limit.retryAfterSec,
      });
      res.setHeader("Retry-After", String(limit.retryAfterSec));
      res.status(429).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Too many requests." },
        id: null,
      });
      return;
    }

    next();
  });

  if (authTokens.length > 0) {
    app.use(
      "/mcp",
      createBearerAuthMiddleware(authTokens, {
        onFailure: (req, res) => {
          metrics.recordAuthFailure();
          logger.warn("auth_failure", {
            requestId: getRequestId(req),
            ip: req.ip ?? "unknown",
            path: getRequestPath(req),
          });

          const key = abuse.clientKey(req);
          const breaker = abuse.breaker.recordFailure();
          if (breaker.openedNow) {
            logger.warn("auth_failure_circuit_breaker", {
              requestId: getRequestId(req),
              ip: req.ip ?? "unknown",
              retryAfterSec: breaker.retryAfterSec,
            });
          }

          const failure = abuse.authFailures.recordFailure(key);
          if (failure.banned) {
            logger.warn("auth_banned", {
              requestId: getRequestId(req),
              ip: req.ip ?? "unknown",
              retryAfterSec: failure.retryAfterSec,
            });
            res.setHeader("Retry-After", String(failure.retryAfterSec));
            res.status(429).json({
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message: "Too many failed authentication attempts.",
              },
              id: null,
            });
            return true;
          }
          return false;
        },
        onSuccess: (req) => {
          abuse.authFailures.recordSuccess(abuse.clientKey(req));
        },
      }),
    );
    // /metrics uses the same bearer check but deliberately bypasses the /mcp
    // abuse controls so a scraper cannot trip the login lockout.
    app.use(
      "/metrics",
      createBearerAuthMiddleware(authTokens, {
        onFailure: (req) => {
          metrics.recordAuthFailure();
          logger.warn("auth_failure", {
            requestId: getRequestId(req),
            ip: req.ip ?? "unknown",
            path: getRequestPath(req),
          });
        },
      }),
    );
  }

  app.get("/metrics", (_req: Request, res: Response) => {
    res.setHeader(
      "Content-Type",
      "text/plain; version=0.0.4; charset=utf-8",
    );
    res.status(200).send(metrics.render());
  });

  let inFlightMcpRequests = 0;

  // Cap concurrent POST work so the backend lock queue cannot grow without
  // bound. The counter is released on both finish and close.
  const concurrencyGuard = (
    _req: Request,
    res: Response,
    next: () => void,
  ) => {
    if (
      abuseConfig.maxConcurrency > 0 &&
      inFlightMcpRequests >= abuseConfig.maxConcurrency
    ) {
      logger.warn("concurrency_limited", {
        requestId: getRequestId(_req),
        ip: _req.ip ?? "unknown",
        maxConcurrency: abuseConfig.maxConcurrency,
      });
      res.setHeader("Retry-After", "1");
      res.status(503).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Server is busy. Try again later." },
        id: null,
      });
      return;
    }

    inFlightMcpRequests += 1;
    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      inFlightMcpRequests -= 1;
    };
    res.once("finish", release);
    res.once("close", release);
    next();
  };

  app.post(
    "/mcp",
    createJsonContentTypeMiddleware(),
    concurrencyGuard,
    async (req: Request, res: Response) => {
      // Create a new server and transport for each request to keep the
      // stateless endpoint free of request ID collisions.
      const server = createTodoMcpServer(backend, {
        readOnly,
        toolset,
        outputSchemas,
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        enableDnsRebindingProtection: true,
        // Host validation is handled by the port-agnostic middleware above.
        allowedOrigins: [...transportOrigins],
        maxRequestBodySize: 64 * 1024,
      });

      res.on("close", () => {
        void transport.close();
        void server.close();
      });

      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        logger.error("mcp_request_error", {
          requestId: getRequestId(req),
          ip: req.ip ?? "unknown",
          message: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          });
        }
      }
    },
  );

  app.get("/mcp", (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });

  app.delete("/mcp", (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });

  return app;
}

export async function main() {
  let config: TodoTxtMcpConfig;
  try {
    config = await loadConfig();
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error("❌ Configuration Error in todo.txt-mcp-config.json:");
      error.issues.forEach((issue) => {
        console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
      });
      process.exitCode = 1;
      return;
    }
    if (error instanceof SyntaxError) {
      console.error(
        "❌ Configuration Error: todo.txt-mcp-config.json is not valid JSON.",
      );
      console.error(`  ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const backend = createBackend(config);

  let trustProxy: ReturnType<typeof parseTrustProxy>;
  try {
    trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
  } catch (error) {
    console.error(
      `❌ ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
    return;
  }

  // Resolve and validate bearer tokens before building the app so a weak or
  // unreadable secret fails fast instead of silently disabling authentication.
  let authTokens: string[] = [];
  try {
    const tokenFile = process.env.MCP_AUTH_TOKEN_FILE?.trim();
    if (tokenFile !== undefined && tokenFile !== "") {
      warnOnInsecureTokenFile(tokenFile);
    }

    const resolvedTokens = resolveAuthTokens({}, process.env);
    if (
      resolvedTokens.source === "env" || resolvedTokens.source === "file"
    ) {
      assertStrongAuthTokens(
        resolvedTokens.tokens,
        isWeakTokenOverrideEnabled(process.env.MCP_ALLOW_WEAK_TOKEN),
        resolvedTokens.source,
      );
    }
    assertAuthTokensConfigured(resolvedTokens.tokens);
    authTokens = resolvedTokens.tokens;
  } catch (error) {
    console.error(
      `❌ ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
    return;
  }

  const app = createApp(backend, {
    ...(trustProxy === undefined ? {} : { trustProxy }),
    ...(authTokens.length > 0 ? { authTokens } : {}),
  });

  const port = Number(process.env.PORT ?? "3000");
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(
      `❌ Invalid PORT "${process.env.PORT}": expected an integer between 0 and 65535.`,
    );
    process.exitCode = 1;
    return;
  }

  const host = process.env.HOST ?? DEFAULT_HOST;

  const server = app.listen(port, host, () => {
    const address = server.address();
    const boundPort = typeof address === "object" && address !== null
      ? address.port
      : port;
    console.log(
      `todo.txt-mcp Server running on http://localhost:${boundPort}`,
    );
    console.log(`MCP Endpoint: http://localhost:${boundPort}/mcp`);
  });

  // Bound slow-body and idle-connection attacks.
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  server.on("error", (error) => {
    console.error("❌ Failed to start todo.txt-mcp server:", error.message);
    process.exitCode = 1;
  });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      console.log(`Received ${signal}, shutting down.`);
      const forceExit = setTimeout(() => process.exit(1), 10_000);
      forceExit.unref();
      server.close(() => {
        clearTimeout(forceExit);
        process.exit(0);
      });
    });
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
