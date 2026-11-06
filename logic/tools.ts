import { z } from "zod";
import { Todo } from "./todo.ts";
import { filterTodos } from "./Todos.ts";
import { TodoStateEnum } from "../types/enums.ts";
import type { TodoBackend } from "./backend.ts";
import { withBackendLock } from "./backend-lock.ts";
import { resolveMaxTodos } from "./limits.ts";
import { guardTool, notFoundError, ToolFailure } from "./tool-errors.ts";
import { contextTokenPattern } from "./tokens.ts";
import { RECURRENCE_PATTERN } from "./recurrence.ts";

// Schemas
export const CompactListTodosSchema = z.object({
  search: z.string().max(200).optional().describe("Search text"),
  status: z.enum(["todo", "done", "all"]).optional().describe(
    "todo (default), done, or all",
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

const ContextNameSchema = z.string().min(1).max(100).regex(
  /^@?[\w.-]+$/,
  "Use letters, digits, '.', '_' or '-'",
).describe("Context name");

const ThresholdSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}$/,
  "Expected YYYY-MM-DD",
).nullable().optional().describe("t: YYYY-MM-DD (defer until); null clears");

const RecurrenceSchema = z.string().regex(
  RECURRENCE_PATTERN,
  "Expected +N[dwmy], e.g. +2w",
).nullable().optional().describe("rec: +2w; null clears");

const TodoEditSchema = z.object({
  hash: z.string().min(8).max(64).describe("Todo hash"),
  priority: z.string().regex(
    /^[A-Z]$/,
    "Expected a single uppercase priority letter (A-Z)",
  ).nullable().optional().describe("A-Z, or null to clear"),
  addContexts: z.array(ContextNameSchema).max(20).optional().describe(
    "Contexts to add",
  ),
  removeContexts: z.array(ContextNameSchema).max(20).optional().describe(
    "Contexts to remove",
  ),
  threshold: ThresholdSchema,
  recurrence: RecurrenceSchema,
  status: z.enum(["done", "todo"]).optional().describe(
    "done to complete, todo to undo",
  ),
});

export type TodoEdit = z.infer<typeof TodoEditSchema>;
type TodoPatch = Omit<TodoEdit, "hash">;

export const CompactUpdateTodosSchema = z.object({
  edits: z.array(TodoEditSchema).min(1).max(100).describe("Edits to apply"),
});

export const CompactDeleteTodosSchema = z.object({
  hashes: z.array(z.string().min(8).max(64)).min(1).max(100).describe(
    "Todo hashes",
  ),
});

function normalizeContextName(name: string): string {
  return name.replace(/^@+/, "").trim();
}

function addContextToText(text: string, name: string): string {
  if (contextTokenPattern(name, false).test(text)) {
    return text;
  }
  const trimmed = text.trim();
  return trimmed.length === 0 ? `@${name}` : `${trimmed} @${name}`;
}

function removeContextFromText(text: string, name: string): string {
  if (!contextTokenPattern(name, false).test(text)) {
    return text;
  }
  return text
    .replace(contextTokenPattern(name, true), "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function hasTodoPatch(patch: TodoPatch): boolean {
  return patch.priority !== undefined ||
    patch.threshold !== undefined ||
    patch.recurrence !== undefined ||
    patch.status !== undefined ||
    (patch.addContexts?.length ?? 0) > 0 ||
    (patch.removeContexts?.length ?? 0) > 0;
}

interface TodoPatchResult {
  recurrence?: Todo;
  changed: boolean;
}

function applyTodoPatch(todo: Todo, patch: TodoPatch): TodoPatchResult {
  const before = todo.toString();
  let recurrence: Todo | undefined;
  if (patch.priority !== undefined) {
    todo.priority = patch.priority === null
      ? undefined
      // The schema only accepts A-Z.
      : patch.priority as Todo["priority"];
  }
  for (const raw of patch.removeContexts ?? []) {
    const name = normalizeContextName(raw);
    if (name.length > 0) {
      todo.setText(removeContextFromText(todo.text, name));
    }
  }
  for (const raw of patch.addContexts ?? []) {
    const name = normalizeContextName(raw);
    if (name.length > 0) {
      todo.setText(addContextToText(todo.text, name));
    }
  }
  if (patch.threshold !== undefined) {
    if (patch.threshold === null) {
      todo.clearTag("t");
    } else {
      todo.setTag("t", patch.threshold);
    }
  }
  if (patch.recurrence !== undefined) {
    if (patch.recurrence === null) {
      todo.clearTag("rec");
    } else {
      todo.setTag("rec", patch.recurrence.toLowerCase());
    }
  }
  // Tags must be applied before status: a completed recurring todo clones them.
  if (patch.status !== undefined) {
    const targetState = patch.status === "done"
      ? TodoStateEnum.done
      : TodoStateEnum.todo;
    if (todo.state !== targetState) {
      recurrence = todo.toggleState().recurrence;
    }
  }
  return { recurrence, changed: todo.toString() !== before };
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

/** Resolves a hash to exactly one todo, rejecting ambiguous duplicates. */
function uniqueTodo(
  index: Map<string, Todo[]>,
  hash: string,
): Todo | undefined {
  const matches = index.get(hash);
  if (matches === undefined) {
    return undefined;
  }
  if (matches.length > 1) {
    throw new ToolFailure(
      "CONFLICT",
      `Hash ${hash} matches ${matches.length} identical todos. ` +
        "Remove or differentiate the duplicate lines, then retry.",
      { hash, count: matches.length },
    );
  }
  return matches[0];
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

  return await withBackendLock(backend, async () => {
    const todos = await backend.load();
    const maxTodos = resolveMaxTodos();
    if (todos.length + texts.length > maxTodos) {
      throw new ToolFailure(
        "LIMIT_EXCEEDED",
        `Cannot add ${texts.length} todo(s): the file already contains ` +
          `${todos.length} and the limit is ${maxTodos} todos ` +
          `(TODOTXT_MCP_MAX_TODOS). Nothing was saved.`,
        {
          maxTodos,
          currentCount: todos.length,
          requestedCount: texts.length,
        },
      );
    }

    const added = texts.map((text) => {
      const todo = new Todo(text);
      if (!todo.creationDate) {
        todo.creationDate = new Date();
      }
      return todo;
    });
    todos.push(...added);
    await backend.save(todos);
    return compactLines(await Promise.all(added.map(todoLine)));
  });
}

export function addTodosHandler(backend: TodoBackend, rawArgs: unknown) {
  return guardTool(() => addTodosOperation(backend, rawArgs));
}

// Tool: update_todos
async function updateTodosOperation(
  backend: TodoBackend,
  rawArgs: unknown,
) {
  const { edits } = CompactUpdateTodosSchema.parse(rawArgs);
  edits.forEach((edit, index) => {
    if (!hasTodoPatch(edit)) {
      throw new ToolFailure(
        "INVALID_ARGUMENT",
        `edits.${index}: provide priority, addContexts, removeContexts, ` +
          "threshold, recurrence, or status.",
      );
    }
  });
  const hashes = edits.map((edit) => edit.hash);
  if (new Set(hashes).size !== hashes.length) {
    throw new ToolFailure(
      "INVALID_ARGUMENT",
      "Each edit must target a different hash.",
    );
  }

  return await withBackendLock(backend, async () => {
    const todos = await backend.load();
    const index = await todoIndex(todos);

    const resolved = new Map<string, Todo>();
    const missing: string[] = [];
    for (const edit of edits) {
      const target = uniqueTodo(index, edit.hash);
      if (target === undefined) {
        missing.push(edit.hash);
      } else {
        resolved.set(edit.hash, target);
      }
    }

    const updated: Todo[] = [];
    let changed = false;

    for (const edit of edits) {
      const target = resolved.get(edit.hash);
      if (target === undefined) {
        continue;
      }
      const result = applyTodoPatch(target, edit);
      if (result.recurrence) {
        todos.push(result.recurrence);
      }
      if (result.changed) {
        changed = true;
      }
      updated.push(target);
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
    const todos = await backend.load();
    const index = await todoIndex(todos);

    const deleted: Todo[] = [];
    const missing: string[] = [];
    for (const hash of hashes) {
      const target = uniqueTodo(index, hash);
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
