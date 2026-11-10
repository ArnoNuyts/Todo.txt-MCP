import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalFileBackend } from "../logic/backends/local-file-backend.ts";
import { AmbiguousTodoError, Todo } from "../logic/todo.ts";
import {
  addTodosHandler,
  deleteTodosHandler,
  listTodosHandler,
  updateTodosHandler,
} from "../logic/tools.ts";
import { MockBackend } from "./helpers/mock-backend.ts";

interface ToolResultLike {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: {
    error?: { code?: string; message?: string };
  };
}

function errorCodeOf(result: unknown): string | undefined {
  return (result as ToolResultLike).structuredContent?.error?.code;
}

function textOf(result: unknown): string {
  return (result as ToolResultLike).content
    .map((item) => item.text ?? "")
    .join("\n");
}

function snapshot(backend: MockBackend): string[] {
  return backend.getTodos().map((todo) => todo.toString());
}

/**
 * Computes the same short hash `Todo.getHash()` produces, from the raw line.
 * This lets a test address a line whose `toString()` is still broken.
 */
function rawHash(line: string): string {
  return createHash("sha256")
    .update(line)
    .digest()
    .subarray(0, 8)
    .toString("base64url");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("T1/F1 invalid-date lockout", () => {
  const raw = "2024-13-01 task";

  it("serializes a loaded impossible date without throwing", () => {
    const todo = new Todo(raw);

    expect(() => todo.toString()).not.toThrow();
    expect(todo.toString()).toBe(raw);
    expect(todo.creationDate).toBeUndefined();
  });

  it("lists an impossible date as its raw line", async () => {
    const backend = new MockBackend();
    await backend.save([new Todo(raw), new Todo("keep")]);

    const result = await listTodosHandler(backend, {
      status: "all",
      limit: 100,
    });

    expect(result).not.toMatchObject({ isError: true });
    expect(textOf(result)).toContain(`${rawHash(raw)} ${raw}`);
    expect(textOf(result)).toContain("keep");
  });

  it("adds a todo while preserving an impossible raw line", async () => {
    const backend = new MockBackend();
    await backend.save([new Todo(raw)]);

    const result = await addTodosHandler(backend, { todos: ["new"] });

    expect(result).not.toMatchObject({ isError: true });
    const lines = snapshot(backend);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(raw);
    expect(lines[1]).toContain("new");
  });

  it("updates an impossible-date line through its hash", async () => {
    const backend = new MockBackend();
    await backend.save([new Todo(raw), new Todo("keep")]);

    const result = await updateTodosHandler(backend, {
      updates: [`${rawHash(raw)} fixed`],
    });

    expect(result).not.toMatchObject({ isError: true });
    expect(snapshot(backend)).toEqual(["fixed", "keep"]);
  });

  it("updates another todo without rewriting an impossible raw line", async () => {
    const backend = new MockBackend();
    const keep = new Todo("keep");
    await backend.save([new Todo(raw), keep]);

    const result = await updateTodosHandler(backend, {
      updates: [`${await keep.getHash()} kept`],
    });

    expect(result).not.toMatchObject({ isError: true });
    expect(snapshot(backend)).toEqual([raw, "kept"]);
  });

  it("deletes an impossible-date line through its hash", async () => {
    const backend = new MockBackend();
    await backend.save([new Todo(raw), new Todo("keep")]);

    const result = await deleteTodosHandler(backend, {
      hashes: [rawHash(raw)],
    });

    expect(result).not.toMatchObject({ isError: true });
    expect(snapshot(backend)).toEqual(["keep"]);
  });
});

describe("T2/F5 invalid dates on write", () => {
  const invalidDates = [
    "2024-13-01",
    "2024-00-00",
    "2024-02-30",
    "2024-01-39",
  ];

  it.each(invalidDates)("rejects add_todos with %s", async (date) => {
    const backend = new MockBackend();
    const saveSpy = vi.spyOn(backend, "save");

    const result = await addTodosHandler(backend, {
      todos: [`${date} task`],
    });

    expect(result).toMatchObject({ isError: true });
    expect(errorCodeOf(result)).toBe("INVALID_ARGUMENT");
    expect(textOf(result)).toContain("Nothing was saved");
    expect(saveSpy).not.toHaveBeenCalled();
    expect(backend.getTodos()).toEqual([]);
  });

  it.each(invalidDates)("rejects update_todos with %s", async (date) => {
    const todo = new Todo("keep");
    const backend = new MockBackend();
    await backend.save([todo]);
    const saveSpy = vi.spyOn(backend, "save");

    const result = await updateTodosHandler(backend, {
      updates: [`${await todo.getHash()} ${date} task`],
    });

    expect(result).toMatchObject({ isError: true });
    expect(errorCodeOf(result)).toBe("INVALID_ARGUMENT");
    expect(textOf(result)).toContain("Nothing was saved");
    expect(saveSpy).not.toHaveBeenCalled();
    expect(snapshot(backend)).toEqual(["keep"]);
  });
});

describe("T3/F2 MAX_TODOS recurrence bypass", () => {
  it("rejects a recurrence that would exceed the cap and saves nothing", async () => {
    vi.stubEnv("TODOTXT_MCP_MAX_TODOS", "5");
    const recurring = new Todo("Task due:2026-02-03 rec:+1w");
    const backend = new MockBackend();
    await backend.save([
      recurring,
      new Todo("t2"),
      new Todo("t3"),
      new Todo("t4"),
      new Todo("t5"),
    ]);
    const before = snapshot(backend);
    const saveSpy = vi.spyOn(backend, "save");

    const result = await updateTodosHandler(backend, {
      updates: [
        `${
          await recurring.getHash()
        } x 2026-02-01 Task due:2026-02-03 rec:+1w`,
      ],
    });

    expect(result).toMatchObject({ isError: true });
    expect(errorCodeOf(result)).toBe("LIMIT_EXCEEDED");
    expect(textOf(result)).toContain("Nothing was saved");
    expect(saveSpy).not.toHaveBeenCalled();
    expect(snapshot(backend)).toEqual(before);
  });

  it("allows a recurrence that exactly reaches the cap", async () => {
    vi.stubEnv("TODOTXT_MCP_MAX_TODOS", "5");
    const recurring = new Todo("Task due:2026-02-03 rec:+1w");
    const backend = new MockBackend();
    await backend.save([
      recurring,
      new Todo("t2"),
      new Todo("t3"),
      new Todo("t4"),
    ]);

    const result = await updateTodosHandler(backend, {
      updates: [
        `${
          await recurring.getHash()
        } x 2026-02-01 Task due:2026-02-03 rec:+1w`,
      ],
    });

    expect(result).not.toMatchObject({ isError: true });
    expect(backend.getTodos()).toHaveLength(5);
  });
});

describe("T4/F4 update error echo", () => {
  it("does not echo a large malformed update payload", async () => {
    const backend = new MockBackend();
    await backend.save([new Todo("keep")]);
    const payload = "x".repeat(2000);

    const result = await updateTodosHandler(backend, {
      updates: [`AAAAAAA ${payload}`],
    });

    expect(result).toMatchObject({ isError: true });
    expect(errorCodeOf(result)).toBe("INVALID_ARGUMENT");
    const message = textOf(result);
    expect(message).toContain("<hash> <text>");
    expect(message).not.toContain(payload);
    expect(message.length).toBeLessThan(300);
  });
});

describe("T5/F6 whitespace-only todo", () => {
  it.each([
    { name: "spaces", value: "   " },
    { name: "tabs", value: "\t\t" },
    { name: "mixed whitespace", value: " \t \t " },
  ])("rejects add_todos with $name", async ({ value }) => {
    const backend = new MockBackend();
    const saveSpy = vi.spyOn(backend, "save");

    const result = await addTodosHandler(backend, { todos: [value] });

    expect(result).toMatchObject({ isError: true });
    expect(errorCodeOf(result)).toBe("INVALID_ARGUMENT");
    expect(textOf(result)).toContain("Nothing was saved");
    expect(saveSpy).not.toHaveBeenCalled();
    expect(backend.getTodos()).toEqual([]);
  });
});

describe("T6/F7 two-date edit", () => {
  it("rejects editing an ambiguous two-date open line instead of dropping a date", async () => {
    const raw = "2024-01-01 2024-02-02 task";
    const todo = new Todo(raw);
    const backend = new MockBackend();
    await backend.save([todo]);
    const saveSpy = vi.spyOn(backend, "save");

    const result = await updateTodosHandler(backend, {
      updates: [`${await todo.getHash()} task edited`],
    });

    expect(result).toMatchObject({ isError: true });
    expect(errorCodeOf(result)).toBe("INVALID_ARGUMENT");
    expect(textOf(result)).toContain("Nothing was saved");
    expect(saveSpy).not.toHaveBeenCalled();
    expect(snapshot(backend)).toEqual([raw]);
  });
});

describe("T7/F8 recurrence edges", () => {
  it("clamps a month-end recurrence to the last day of the month", () => {
    const todo = new Todo("Task due:2026-01-31 rec:+1m");

    const { recurrence } = todo.toggleState(
      new Date("2026-01-31T12:00:00.000Z"),
    );

    expect(recurrence?.tags.due).toBe("2026-02-28");
  });

  it("clamps a leap-day yearly recurrence", () => {
    const todo = new Todo("Task due:2024-02-29 rec:+1y");

    const { recurrence } = todo.toggleState(
      new Date("2024-02-29T12:00:00.000Z"),
    );

    expect(recurrence?.tags.due).toBe("2025-02-28");
  });

  it("rejects an out-of-range rec value with INVALID_ARGUMENT and saves nothing", async () => {
    const raw = "Task due:2099-01-01 rec:+999999999d";
    const todo = new Todo(raw);
    const backend = new MockBackend();
    await backend.save([todo]);
    const saveSpy = vi.spyOn(backend, "save");

    const result = await updateTodosHandler(backend, {
      updates: [
        `${
          await todo.getHash()
        } x 2026-11-08 Task due:2099-01-01 rec:+999999999d`,
      ],
    });

    expect(result).toMatchObject({ isError: true });
    expect(errorCodeOf(result)).toBe("INVALID_ARGUMENT");
    expect(textOf(result)).toContain("Nothing was saved");
    expect(saveSpy).not.toHaveBeenCalled();
    expect(snapshot(backend)).toEqual([raw]);
  });

  it("rejects a shifted threshold that leaves the supported year range", async () => {
    const raw = "Task due:9999-01-01 t:9999-12-31 rec:+1d";
    const todo = new Todo(raw);
    const backend = new MockBackend();
    await backend.save([todo]);
    const saveSpy = vi.spyOn(backend, "save");

    const result = await updateTodosHandler(backend, {
      updates: [
        `${
          await todo.getHash()
        } x 9999-01-02 Task due:9999-01-01 t:9999-12-31 rec:+1d`,
      ],
    });

    expect(result).toMatchObject({ isError: true });
    expect(errorCodeOf(result)).toBe("INVALID_ARGUMENT");
    expect(textOf(result)).toContain("out of range");
    expect(saveSpy).not.toHaveBeenCalled();
    expect(snapshot(backend)).toEqual([raw]);
  });
});

describe("review follow-ups", () => {
  it("lists only the impossible date token when the other date is valid", () => {
    const todo = new Todo("x 2024-13-01 2024-01-01 task");

    expect(todo.invalidDateTokens).toEqual(["2024-13-01"]);
  });

  it("keeps a two-date line raw for display and hashing", () => {
    const raw = "2024-01-01 2024-02-02 task";
    const todo = new Todo(raw);

    expect(todo.toString()).toBe(raw);
    expect(todo.toDisplayString()).toBe(raw);
  });

  it("treats an invalid date followed by a valid date as ambiguous too", async () => {
    const raw = "2024-13-01 2024-01-01 task";
    const todo = new Todo(raw);
    const backend = new MockBackend();
    await backend.save([todo]);
    const saveSpy = vi.spyOn(backend, "save");

    const result = await updateTodosHandler(backend, {
      updates: [`${await todo.getHash()} task edited`],
    });

    expect(result).toMatchObject({ isError: true });
    expect(errorCodeOf(result)).toBe("INVALID_ARGUMENT");
    expect(textOf(result)).toContain("two");
    expect(saveSpy).not.toHaveBeenCalled();
    expect(snapshot(backend)).toEqual([raw]);
  });

  it("refuses to toggle a two-date line without dropping a date", () => {
    const todo = new Todo("2024-01-01 2024-02-02 task");

    expect(() => todo.toggleState()).toThrow(AmbiguousTodoError);
    expect(todo.toString()).toBe("2024-01-01 2024-02-02 task");
  });

  it("round-trips an impossible-date line through the local file backend", async () => {
    const directory = await mkdtemp(join(tmpdir(), "todo-secfix-"));
    const filename = join(directory, "todo.txt");
    try {
      await writeFile(filename, "2024-13-01 task\nkeep\n", "utf8");
      const backend = new LocalFileBackend(filename);
      const todos = await backend.load();
      todos.push(new Todo("new"));
      await backend.save(todos);

      expect(await readFile(filename, "utf8")).toBe(
        "2024-13-01 task\nkeep\nnew\n",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
