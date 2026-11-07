import { z } from "zod";
import { Todo } from "./todo.ts";
import { filterTodos } from "./Todos.ts";
import { TodoStateEnum } from "../types/enums.ts";
import type { TodoBackend } from "./backend.ts";
import { withBackendLock } from "./backend-lock.ts";
import { resolveMaxTodos } from "./limits.ts";
import { guardTool, notFoundError, ToolFailure } from "./tool-errors.ts";

// Schemas
export const CompactListTodosSchema = z.object({
  search: z.string().max(200).optional().describe("Search text"),
  status: z.enum(["todo", "done", "all"]).optional().describe(
    "todo (default), done, or all (includes hidden and future-threshold)",
  ),
  context: z.string().min(1).max(100).optional().describe("Context filter"),
  limit: z.number().int().min(1).max(100).optional().describe(
    "Max rows (default 20)",
  ),
  offset: z.number().int().min(0).optional().describe(
    "Rows to skip (default 0)",
  ),
});

export const CompactAddTodosSchema = z.object({
  todos: z.array(z.string().min(1).max(2000)).min(1).max(100).describe(
    "Todo texts",
  ),
});

export const CompactUpdateTodosSchema = z.object({
  updates: z.array(z.string().min(3).max(2100)).min(1).max(100).describe(
    "'<hash> <new todo.txt line>' lines; updates the first matching line",
  ),
});

export const CompactDeleteTodosSchema = z.object({
  hashes: z.array(z.string().min(8).max(64)).min(1).max(100).describe(
    "Todo hashes; deletes the first matching line",
  ),
});

/**
 * Characters that a todo line must never contain: they would persist as
 * multiple physical todo.txt lines (or as line breaks for consumers that
 * treat U+2028/U+2029 as line terminators).
 */
const LINE_SEPARATOR_PATTERN = /[\n\r\u2028\u2029]/;

/**
 * C0 controls, DEL, and C1 controls would be persisted into the todo file.
 * Tab is the only control character a todo line may contain; NUL in particular
 * makes many consumers treat the rest of the file as binary.
 */
const CONTROL_CHARACTER_PATTERN =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

function describeControl(character: string): string {
  const code = character.codePointAt(0) ?? 0;
  return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
}

function describeSeparator(separator: string): string {
  switch (separator) {
    case "\n":
      return "line feed (U+000A)";
    case "\r":
      return "carriage return (U+000D)";
    case "\u2028":
      return "line separator (U+2028)";
    case "\u2029":
      return "paragraph separator (U+2029)";
    default:
      return "line separator";
  }
}

/**
 * Rejects text that cannot be stored safely as one todo line before a
 * {@link Todo} is constructed. The error deliberately reports only the
 * character class and offset, never the input itself, so a large invalid
 * payload is not echoed back.
 */
function assertSingleLine(text: string, field: string): void {
  const separatorMatch = LINE_SEPARATOR_PATTERN.exec(text);
  if (separatorMatch !== null) {
    const separator = describeSeparator(separatorMatch[0]);
    throw new ToolFailure(
      "INVALID_ARGUMENT",
      `${field} must be a single line; found an embedded ${separator}. ` +
        "Remove the line separator and retry. Nothing was saved.",
      { separator, index: separatorMatch.index },
    );
  }

  const controlMatch = CONTROL_CHARACTER_PATTERN.exec(text);
  if (controlMatch !== null) {
    const control = describeControl(controlMatch[0]);
    throw new ToolFailure(
      "INVALID_ARGUMENT",
      `${field} must not contain control characters; found ${control}. ` +
        "Remove the control character and retry. Nothing was saved.",
      { control, index: controlMatch.index },
    );
  }

  if (!text.isWellFormed()) {
    throw new ToolFailure(
      "INVALID_ARGUMENT",
      `${field} must be valid Unicode; found an unpaired surrogate. ` +
        "Replace it with a complete character and retry. Nothing was saved.",
    );
  }
}

async function todoLine(todo: Todo): Promise<string> {
  return `${await todo.getHash()} ${todo.toDisplayString()}`;
}

async function todoIndex(
  todos: readonly Todo[],
): Promise<Map<string, Todo[]>> {
  const index = new Map<string, Todo[]>();
  for (const todo of todos) {
    const hash = await todo.getHash();
    const matches = index.get(hash);
    if (matches === undefined) {
      index.set(hash, [todo]);
    } else {
      matches.push(todo);
    }
  }
  return index;
}

/**
 * Resolves a hash to its first matching todo in file order. Identical lines
 * share a hash, so each call changes one of them; repeating the call peels
 * the group one line at a time.
 */
function firstMatchingTodo(
  index: Map<string, Todo[]>,
  hash: string,
): Todo | undefined {
  const matches = index.get(hash);
  if (matches === undefined || matches.length === 0) {
    return undefined;
  }
  const first = matches[0];
  if (matches.some((todo) => todo.toString() !== first.toString())) {
    throw new ToolFailure(
      "CONFLICT",
      `Hash ${hash} matches different todo lines (hash collision). ` +
        "Nothing was changed; refresh with list_todos and retry.",
      { hash, count: matches.length },
    );
  }
  return first;
}

function compactLines(lines: readonly string[]) {
  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
  };
}

function batchLines(
  applied: readonly string[],
  missing: readonly string[],
  verb: "updated" | "deleted",
) {
  if (missing.length === 0) {
    return compactLines(applied);
  }
  return compactLines([
    `PARTIAL ${applied.length} ${verb}, ${missing.length} not found; ` +
    "call list_todos to refresh hashes.",
    ...applied,
    ...missing.map((hash) => `ERROR ${hash} not found`),
  ]);
}

// Tool: list_todos
async function compactListTodosOperation(
  backend: TodoBackend,
  rawArgs: unknown,
) {
  const args = CompactListTodosSchema.parse(rawArgs ?? {});
  const todos = await backend.load();
  const filtered = filterTodos(todos, {
    search: args.search,
    status: args.status ?? "todo",
    context: args.context,
  });
  const offset = args.offset ?? 0;
  const page = filtered.slice(offset, offset + (args.limit ?? 20));
  if (page.length === 0) {
    return compactLines([
      filtered.length === 0
        ? "No todos found matching criteria."
        : `No todos at offset ${offset}; ${filtered.length} match.`,
    ]);
  }

  const lines = await Promise.all(page.map(todoLine));
  const next = offset + page.length;
  if (next < filtered.length) {
    lines.push(`MORE ${filtered.length - next} (offset=${next})`);
  }
  return compactLines(lines);
}

export function listTodosHandler(backend: TodoBackend, rawArgs: unknown) {
  return guardTool(() => compactListTodosOperation(backend, rawArgs));
}

// Tool: add_todos
async function addTodosOperation(
  backend: TodoBackend,
  rawArgs: unknown,
) {
  const { todos: texts } = CompactAddTodosSchema.parse(rawArgs);
  for (const text of texts) {
    assertSingleLine(text, "Todo text");
  }

  return await withBackendLock(backend, async () => {
    const todos = [...await backend.load()];
    const existing = new Map<string, Todo>();
    for (const todo of todos) {
      const key = todo.toString();
      if (!existing.has(key)) {
        existing.set(key, todo);
      }
    }
    const added: Todo[] = [];
    const skipped: Array<{ hash: string; text: string }> = [];
    for (const text of texts) {
      const todo = new Todo(text);
      if (!todo.creationDate) {
        todo.creationDate = new Date();
      }
      const key = todo.toString();
      const duplicate = existing.get(key);
      if (duplicate !== undefined) {
        // Adding an existing line is an idempotent no-op. Returning the
        // existing hash makes retries safe without creating a duplicate.
        skipped.push({ hash: await duplicate.getHash(), text });
        continue;
      }
      existing.set(key, todo);
      added.push(todo);
    }

    const maxTodos = resolveMaxTodos();
    // Every accepted input element is exactly one persisted line:
    // `assertSingleLine` rejected embedded separators above.
    if (todos.length + added.length > maxTodos) {
      throw new ToolFailure(
        "LIMIT_EXCEEDED",
        `Cannot add ${added.length} todo(s): the file already contains ` +
          `${todos.length} and the limit is ${maxTodos} todos ` +
          `(TODOTXT_MCP_MAX_TODOS). Nothing was saved.`,
        {
          maxTodos,
          currentCount: todos.length,
          requestedCount: added.length,
        },
      );
    }

    todos.push(...added);
    if (added.length > 0) {
      await backend.save(todos);
    }
    const lines = await Promise.all(added.map(todoLine));
    lines.push(
      ...await Promise.all(
        skipped.map(async ({ hash, text }) => `SKIPPED ${hash} ${text}`),
      ),
    );
    return compactLines(lines);
  });
}

export function addTodosHandler(backend: TodoBackend, rawArgs: unknown) {
  return guardTool(() => addTodosOperation(backend, rawArgs));
}

// Tool: update_todos
interface TextUpdate {
  hash: string;
  text: string;
}

function parseTextUpdate(line: string): TextUpdate {
  // Defense in depth: the regexp below also rejects line terminators, but an
  // explicit guard gives a clear error and never lets one reach `new Todo`.
  assertSingleLine(line, "Update text");
  const match = /^([A-Za-z0-9_-]{8,64})\s+(.+)$/.exec(line.trim());
  if (match === null) {
    throw new ToolFailure(
      "INVALID_ARGUMENT",
      `Each update must be '<hash> <text>': ${line}`,
    );
  }
  return { hash: match[1], text: match[2] };
}

function buildReplacement(target: Todo, text: string): {
  next: Todo;
  recurrence?: Todo;
} {
  const next = new Todo(text);
  if (!next.creationDate) {
    next.creationDate = target.creationDate;
  }

  let recurrence: Todo | undefined;
  if (next.isDone()) {
    if (target.isDone()) {
      if (!next.completionDate) {
        next.completionDate = target.completionDate;
      }
    } else {
      const requestedCompletion = next.completionDate;
      next.state = TodoStateEnum.todo;
      next.completionDate = undefined;
      recurrence = next.toggleState(requestedCompletion).recurrence;
    }
  } else {
    next.completionDate = undefined;
  }

  return { next, recurrence };
}

function applyReplacement(todos: Todo[], target: Todo, next: Todo): void {
  const index = todos.indexOf(target);
  if (index >= 0) {
    todos[index] = next;
  }
}

async function updateTodosOperation(
  backend: TodoBackend,
  rawArgs: unknown,
) {
  const { updates } = CompactUpdateTodosSchema.parse(rawArgs);
  const parsed = updates.map(parseTextUpdate);
  const hashes = parsed.map((update) => update.hash);
  if (new Set(hashes).size !== hashes.length) {
    throw new ToolFailure(
      "INVALID_ARGUMENT",
      "Each update must target a different hash.",
    );
  }

  return await withBackendLock(backend, async () => {
    const todos = [...await backend.load()];
    const index = await todoIndex(todos);

    const resolved: Array<{ update: TextUpdate; target: Todo }> = [];
    const missing: string[] = [];
    for (const update of parsed) {
      const target = firstMatchingTodo(index, update.hash);
      if (target === undefined) {
        missing.push(update.hash);
      } else {
        resolved.push({ update, target });
      }
    }

    const lineCounts = new Map<string, number>();
    for (const todo of todos) {
      const key = todo.toString();
      lineCounts.set(key, (lineCounts.get(key) ?? 0) + 1);
    }

    const updated: Todo[] = [];
    let changed = false;
    for (const { update, target } of resolved) {
      const { next, recurrence } = buildReplacement(target, update.text);
      const targetKey = target.toString();
      const nextKey = next.toString();
      if (
        nextKey !== targetKey &&
        (lineCounts.get(nextKey) ?? 0) > 0
      ) {
        throw new ToolFailure(
          "CONFLICT",
          `Cannot update ${update.hash}: the new line duplicates another ` +
            "todo. Nothing was saved.",
          { hash: update.hash },
        );
      }

      const before = target.toString();
      applyReplacement(todos, target, next);
      if (nextKey !== targetKey) {
        lineCounts.set(targetKey, (lineCounts.get(targetKey) ?? 1) - 1);
        lineCounts.set(nextKey, (lineCounts.get(nextKey) ?? 0) + 1);
      }
      if (recurrence || next.toString() !== before) {
        changed = true;
      }
      updated.push(next);
      if (recurrence) {
        todos.push(recurrence);
        const recurrenceKey = recurrence.toString();
        lineCounts.set(
          recurrenceKey,
          (lineCounts.get(recurrenceKey) ?? 0) + 1,
        );
        // The caller needs the new hash to complete the follow-up task.
        updated.push(recurrence);
      }
    }

    if (changed) {
      await backend.save(todos);
    }
    if (updated.length === 0) {
      return notFoundError(missing[0]);
    }

    return batchLines(
      await Promise.all(updated.map(todoLine)),
      missing,
      "updated",
    );
  });
}

export function updateTodosHandler(backend: TodoBackend, rawArgs: unknown) {
  return guardTool(() => updateTodosOperation(backend, rawArgs));
}

// Tool: delete_todos
async function deleteTodosOperation(
  backend: TodoBackend,
  rawArgs: unknown,
) {
  const { hashes } = CompactDeleteTodosSchema.parse(rawArgs);
  if (new Set(hashes).size !== hashes.length) {
    throw new ToolFailure(
      "INVALID_ARGUMENT",
      "Each hash must be different.",
    );
  }

  return await withBackendLock(backend, async () => {
    const todos = [...await backend.load()];
    const index = await todoIndex(todos);

    const deleted: Todo[] = [];
    const missing: string[] = [];
    for (const hash of hashes) {
      const target = firstMatchingTodo(index, hash);
      if (target === undefined) {
        missing.push(hash);
      } else {
        deleted.push(target);
      }
    }

    if (deleted.length > 0) {
      const toDelete = new Set(deleted);
      await backend.save(todos.filter((todo) => !toDelete.has(todo)));
    }
    if (deleted.length === 0) {
      return notFoundError(missing[0]);
    }

    return batchLines(
      await Promise.all(deleted.map(todoLine)),
      missing,
      "deleted",
    );
  });
}

export function deleteTodosHandler(
  backend: TodoBackend,
  rawArgs: unknown,
) {
  return guardTool(() => deleteTodosOperation(backend, rawArgs));
}
