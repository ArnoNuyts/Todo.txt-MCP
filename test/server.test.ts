import { beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Todo } from "../logic/todo.ts";
import {
  addTodoHandler,
  addTodosHandler,
  deleteCompletedHandler,
  deleteTodoHandler,
  deleteTodosHandler,
  editTodoHandler,
  listTodosHandler,
  setTodoStatusesHandler,
  setTodoStatusHandler,
  updateTodosHandler,
} from "../server.ts";
import { TodoStateEnum } from "../types/enums.ts";
import { LocalFileBackend } from "../logic/backends/local-file-backend.ts";
import { MockBackend } from "./helpers/mock-backend.ts";

interface TodoSummary {
  hash: string;
  text: string;
  status: "todo" | "done";
}

interface UpdatedTodoSummary extends TodoSummary {
  previousHash: string;
}

interface BatchFailure {
  hash: string;
  code: string;
  message: string;
}

function structured<T>(result: unknown): T {
  return (result as { structuredContent: T }).structuredContent;
}

function errorOf(result: unknown): { code: string; message: string } {
  return (result as { structuredContent: { error: { code: string; message: string } } })
    .structuredContent.error;
}

describe("Server tool handlers", () => {
  const backend = new MockBackend();

  beforeEach(() => {
    backend.reset();
  });

  describe("addTodoHandler", () => {
    it("should add a single todo", async () => {
      const args = {
        todos: ["first todo"],
      };
      const result = await addTodoHandler(backend, args);

      const storedTodos = backend.getTodos();
      expect(storedTodos.length).toBe(1);
      expect(storedTodos[0].text).toBe("first todo");

      const todo1Hash = await storedTodos[0].getHash();
      const expectedText = `Added todo [${todo1Hash}]: ${
        storedTodos[0].toDisplayString()
      }`;

      expect(result.content[0].text).toBe(expectedText);
      expect(result.structuredContent).toEqual({
        added: [{
          hash: todo1Hash,
          text: storedTodos[0].toDisplayString(),
          status: "todo",
        }],
        skipped: [],
      });
    });

    it("should add multiple todos", async () => {
      const args = {
        todos: ["first todo", "second todo"],
      };
      const result = await addTodoHandler(backend, args);

      const storedTodos = backend.getTodos();
      expect(storedTodos.length).toBe(2);
      expect(storedTodos[0].text).toBe("first todo");
      expect(storedTodos[1].text).toBe("second todo");

      const todo1Hash = await storedTodos[0].getHash();
      const todo2Hash = await storedTodos[1].getHash();

      const newTodoStrings = [
        `Added todo [${todo1Hash}]: ${storedTodos[0].toDisplayString()}`,
        `Added todo [${todo2Hash}]: ${storedTodos[1].toDisplayString()}`,
      ];

      expect(result.content[0].text).toBe(newTodoStrings.join("\n"));
    });

    it("should handle adding to an existing list of todos", async () => {
      // Pre-populate backend
      await backend.save([new Todo("existing todo")]);

      const args = {
        todos: ["new todo"],
      };
      await addTodoHandler(backend, args);

      const storedTodos = backend.getTodos();
      expect(storedTodos.length).toBe(2);
      expect(storedTodos[0].text).toBe("existing todo");
      expect(storedTodos[1].text).toBe("new todo");
    });

    it("should reject too many todos", async () => {
      const args = {
        todos: Array.from({ length: 101 }, (_, i) => `todo ${i}`),
      };

      const result = await addTodoHandler(backend, args);
      expect(result).toMatchObject({ isError: true });
      expect(errorOf(result).code).toBe("INVALID_ARGUMENT");
      expect(backend.getTodos()).toHaveLength(0);
    });

    it("should reject an overlong todo", async () => {
      const result = await addTodoHandler(backend, { todos: ["a".repeat(2001)] });
      expect(result).toMatchObject({ isError: true });
      expect(errorOf(result).code).toBe("INVALID_ARGUMENT");
      expect(backend.getTodos()).toHaveLength(0);
    });

    it("should persist both of two concurrent adds", async () => {
      const directory = await mkdtemp(join(tmpdir(), "todo-txt-mcp-concurrent-"));
      try {
        const fileBackend = new LocalFileBackend(join(directory, "todo.txt"));

        await Promise.all([
          addTodoHandler(fileBackend, { todos: ["first concurrent"] }),
          addTodoHandler(fileBackend, { todos: ["second concurrent"] }),
        ]);

        const stored = await fileBackend.load();
        expect([...stored].map((todo) => todo.text).sort()).toEqual([
          "first concurrent",
          "second concurrent",
        ]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  });

  describe("editTodoHandler", () => {
    it("should edit a single todo", async () => {
      const initialTodos = [new Todo("todo to be edited")];
      await backend.save(initialTodos);
      const hash = await initialTodos[0].getHash();

      const args = {
        edits: [{ hash: hash, text: "edited text" }],
      };

      const result = await editTodoHandler(backend, args);

      const storedTodos = backend.getTodos();
      expect(storedTodos.length).toBe(1);
      expect(storedTodos[0].text).toBe("edited text");

      const newHash = await storedTodos[0].getHash();
      expect(result.content[0].text).toBe(
        `Edited todo [${newHash}]: ${storedTodos[0].toDisplayString()}`,
      );
      expect(result.structuredContent).toEqual({
        succeeded: [{
          hash: newHash,
          previousHash: hash,
          text: storedTodos[0].toDisplayString(),
          status: "todo",
        }],
        failed: [],
      });
    });

    it("should edit multiple todos", async () => {
      const initialTodos = [new Todo("first todo"), new Todo("second todo")];
      await backend.save(initialTodos);
      const hash1 = await initialTodos[0].getHash();
      const hash2 = await initialTodos[1].getHash();

      const args = {
        edits: [
          { hash: hash1, text: "edited first" },
          { hash: hash2, text: "edited second" },
        ],
      };

      await editTodoHandler(backend, args);

      const storedTodos = backend.getTodos();
      expect(storedTodos.length).toBe(2);
      // order is not guaranteed.
      const texts = storedTodos.map((t) => t.text).sort();
      expect(texts).toEqual(["edited first", "edited second"]);
    });

    it("should return an error if a hash is not found", async () => {
      await backend.save([new Todo("a todo")]);

      const args = {
        edits: [{ hash: "nonexistent", text: "new text" }],
      };

      const result = await editTodoHandler(backend, args);

      expect(result.content[0].text).toBe(
        "Todo with hash nonexistent not found.",
      );

      // And the valid todo should not be changed
      const storedTodos = backend.getTodos();
      expect(storedTodos.length).toBe(1);
      expect(storedTodos[0].text).toBe("a todo");
    });

    it("should handle a mix of valid and invalid hashes", async () => {
      const initialTodos = [new Todo("todo to edit")];
      await backend.save(initialTodos);
      const hash = await initialTodos[0].getHash();

      const args = {
        edits: [
          { hash: hash, text: "edited text" },
          { hash: "nonexistent", text: "new text" },
        ],
      };

      const result = await editTodoHandler(backend, args);
      const storedTodos = backend.getTodos();

      const newHash = await storedTodos[0].getHash();
      const expectedSuccess = `Edited todo [${newHash}]: ${
        storedTodos[0].toDisplayString()
      }`;
      const expectedError = "Todo with hash nonexistent not found.";

      // The output can be in any order.
      const resultingTexts = result.content[0].text.split("\n").sort();
      const expectedTexts = [expectedSuccess, expectedError].sort();

      expect(resultingTexts).toEqual(expectedTexts);

      // Check stored todos
      expect(storedTodos[0].text).toBe("edited text");

      expect(result.structuredContent).toEqual({
        succeeded: [{
          hash: newHash,
          previousHash: hash,
          text: storedTodos[0].toDisplayString(),
          status: "todo",
        }],
        failed: [{
          hash: "nonexistent",
          code: "TODO_NOT_FOUND",
          message: "Todo with hash nonexistent not found.",
        }],
      });
    });
  });

  describe("listTodosHandler", () => {
    beforeEach(async () => {
      await backend.save([
        new Todo("Active Task 1"),
        new Todo("Active Task 2"),
        new Todo("x Done Task 1"),
        new Todo("x Done Task 2"),
        new Todo("UniqueSearchTerm Task"),
      ]);
    });

    it("should return only active todos by default", async () => {
      const result = await listTodosHandler(backend, { format: "both" });
      const text = result.content[0].text as string;
      expect(text.includes("Active Task 1")).toBe(true);
      expect(text.includes("Done Task 1")).toBe(false);
      expect(result.structuredContent).toMatchObject({
        total: 3,
        nextOffset: null,
      });
    });

    it("should return only done todos when status is 'done'", async () => {
      const result = await listTodosHandler(backend, { status: "done", format: "both" });
      const text = result.content[0].text as string;
      expect(text.includes("Active Task 1")).toBe(false);
      expect(text.includes("Done Task 1")).toBe(true);
    });

    it("should return all todos when status is 'all'", async () => {
      const result = await listTodosHandler(backend, { status: "all", format: "both" });
      const text = result.content[0].text as string;
      expect(text.includes("Active Task 1")).toBe(true);
      expect(text.includes("Done Task 1")).toBe(true);
    });

    it("should filter todos by search term", async () => {
      const result = await listTodosHandler(backend, {
        search: "UniqueSearchTerm",
        format: "both",
      });
      const text = result.content[0].text as string;
      expect(text.includes("UniqueSearchTerm")).toBe(true);
      expect(text.includes("Active Task 1")).toBe(false);
    });

    it("should apply pagination limit", async () => {
      const result = await listTodosHandler(backend, { limit: 1, format: "both" });
      const text = result.content[0].text as string;
      const lines = text.split("\n").filter((l) => l.trim() !== "");
      expect(lines.length).toBe(1);
      expect(result.structuredContent).toMatchObject({
        total: 3,
        nextOffset: 1,
      });
    });

    it("should include todo details in structured content", async () => {
      const result = await listTodosHandler(backend, { status: "all", format: "both" });
      const structured = result.structuredContent as {
        todos: Array<Record<string, unknown>>;
        total: number;
      };

      expect(structured.total).toBe(5);
      expect(structured.todos).toHaveLength(5);
      const done = structured.todos.find((todo) =>
        todo.text === "x Done Task 1"
      );
      expect(done).toBeDefined();
      expect(done!.status).toBe("done");
      expect(done!.hash).toMatch(/^[0-9a-f]{16}$/);
    });

    it("should reject an out-of-range limit", async () => {
      for (const limit of [0, 501]) {
        const result = await listTodosHandler(backend, { limit });
        expect(result).toMatchObject({ isError: true });
        expect(errorOf(result).code).toBe("INVALID_ARGUMENT");
      }
    });
  });

  describe("setTodoStatusHandler", () => {
    it("should mark a todo as done", async () => {
      const initialTodos = [new Todo("task to complete")];
      await backend.save(initialTodos);
      const hash = await initialTodos[0].getHash();

      const result = await setTodoStatusHandler(backend, {
        hash,
        status: "done",
      });

      const storedTodos = backend.getTodos();
      expect(storedTodos.length).toBe(1);
      expect(storedTodos[0].state).toBe(TodoStateEnum.done);
      expect(storedTodos[0].isDone()).toBe(true);

      const newHash = await storedTodos[0].getHash();
      expect(result.content[0].text).toBe(
        `Set todo [${newHash}] status to done: ${storedTodos[0].toDisplayString()}`,
      );
      expect("structuredContent" in result).toBe(true);
      expect(
        (result as { structuredContent: unknown }).structuredContent,
      ).toEqual({
        hash: newHash,
        status: "done",
        text: storedTodos[0].toDisplayString(),
      });
    });

    it("should mark a done todo as todo again", async () => {
      const initialTodos = [new Todo("x task to reopen")];
      await backend.save(initialTodos);
      const hash = await initialTodos[0].getHash();

      const result = await setTodoStatusHandler(backend, {
        hash,
        status: "todo",
      });

      const storedTodos = backend.getTodos();
      expect(storedTodos.length).toBe(1);
      expect(storedTodos[0].state).toBe(TodoStateEnum.todo);
      expect(storedTodos[0].isDone()).toBe(false);
      expect(storedTodos[0].completionDate).toBeUndefined();
      expect(storedTodos[0].text).toBe("task to reopen");

      expect(result.content[0].text).toBe(
        `Set todo [${await storedTodos[0]
          .getHash()}] status to todo: ${storedTodos[0].toDisplayString()}`,
      );
    });

    it("should return an error for an unknown hash", async () => {
      await backend.save([new Todo("a todo")]);

      const result = await setTodoStatusHandler(backend, {
        hash: "nonexistent",
        status: "done",
      });

      expect(result).toMatchObject({ isError: true });
      expect(result.content[0].text).toBe(
        "Todo with hash nonexistent not found. Call list_todos to refresh hashes.",
      );
      expect(errorOf(result)).toMatchObject({
        code: "TODO_NOT_FOUND",
        details: {
          hash: "nonexistent",
          hint: "call list_todos to refresh hashes",
        },
      });

      // The existing todo should be untouched.
      const storedTodos = backend.getTodos();
      expect(storedTodos.length).toBe(1);
      expect(storedTodos[0].state).toBe(TodoStateEnum.todo);
    });
  });

  describe("deleteTodoHandler", () => {
    it("should delete a todo by hash", async () => {
      const initialTodos = [new Todo("task to delete"), new Todo("keep me")];
      await backend.save(initialTodos);
      const hash = await initialTodos[0].getHash();

      const result = await deleteTodoHandler(backend, { hash });

      expect(result).not.toMatchObject({ isError: true });
      expect(result.content[0].text).toBe(`Deleted todo [${hash}]`);
      expect(
        (result as { structuredContent?: unknown }).structuredContent,
      ).toEqual({ deleted: true, hash });

      const storedTodos = backend.getTodos();
      expect(storedTodos).toHaveLength(1);
      expect(storedTodos[0].text).toBe("keep me");
    });

    it("should return an error when the hash is missing", async () => {
      await backend.save([new Todo("keep me")]);

      const result = await deleteTodoHandler(backend, {
        hash: "0123456789abcdef",
      });

      expect(result).toMatchObject({ isError: true });
      expect(result.content[0].text).toBe(
        "Todo with hash 0123456789abcdef not found. " +
          "Call list_todos to refresh hashes.",
      );
      expect(errorOf(result).code).toBe("TODO_NOT_FOUND");

      const storedTodos = backend.getTodos();
      expect(storedTodos).toHaveLength(1);
      expect(storedTodos[0].text).toBe("keep me");
    });

    it("should reject a hash outside the allowed length", async () => {
      const result = await deleteTodoHandler(backend, { hash: "short" });
      expect(result).toMatchObject({ isError: true });
      expect(errorOf(result).code).toBe("INVALID_ARGUMENT");
    });
  });

  describe("addTodosHandler", () => {
    it("should allow duplicates by default", async () => {
      await backend.save([new Todo("Buy Milk")]);

      const result = await addTodosHandler(backend, { todos: ["buy milk"] });
      const content = structured<
        { added: TodoSummary[]; skipped: Array<{ text: string; hash: string }> }
      >(result);

      expect(content.added).toHaveLength(1);
      expect(content.skipped).toEqual([]);
      expect(backend.getTodos()).toHaveLength(2);
    });

    it("should skip duplicates and report them", async () => {
      const existing = new Todo("Buy Milk");
      await backend.save([existing]);
      const existingHash = await existing.getHash();
      backend.loadCalls = 0;
      backend.saveCalls = 0;

      const result = await addTodosHandler(backend, {
        todos: ["  BUY   milk "],
        onDuplicate: "skip",
      });
      const content = structured<
        { added: TodoSummary[]; skipped: Array<{ text: string; hash: string }> }
      >(result);

      expect(content.added).toEqual([]);
      expect(content.skipped).toEqual([{
        text: "  BUY   milk ",
        hash: existingHash,
      }]);
      expect(backend.getTodos()).toHaveLength(1);
      expect(backend.loadCalls).toBe(1);
      expect(backend.saveCalls).toBe(0);
    });

    it("should ignore the x marker, dates, and idem tags when detecting duplicates", async () => {
      const done = new Todo("x 2025-01-01 2024-06-01 buy milk idem:old");
      await backend.save([done]);
      const doneHash = await done.getHash();

      const result = await addTodosHandler(backend, {
        todos: ["2025-01-01 BUY MILK idem:new"],
        onDuplicate: "skip",
      });
      const content = structured<
        { added: TodoSummary[]; skipped: Array<{ text: string; hash: string }> }
      >(result);

      expect(content.added).toEqual([]);
      expect(content.skipped).toEqual([{
        text: "2025-01-01 BUY MILK idem:new",
        hash: doneHash,
      }]);
      expect(backend.getTodos()).toHaveLength(1);
    });

    it("should skip duplicates within the same request", async () => {
      const result = await addTodosHandler(backend, {
        todos: ["same task", "same task"],
        onDuplicate: "skip",
      });
      const content = structured<
        { added: TodoSummary[]; skipped: Array<{ text: string; hash: string }> }
      >(result);

      expect(content.added).toHaveLength(1);
      expect(content.skipped).toHaveLength(1);
      expect(content.skipped[0].hash).toBe(content.added[0].hash);
      expect(backend.getTodos()).toHaveLength(1);
      expect(backend.saveCalls).toBe(1);
    });

    it("should reject every duplicate with onDuplicate error and write nothing", async () => {
      await backend.save([new Todo("buy milk")]);
      backend.saveCalls = 0;

      const result = await addTodosHandler(backend, {
        todos: ["buy milk", "fresh task"],
        onDuplicate: "error",
      });

      expect(result).toMatchObject({ isError: true });
      expect(result.content[0].text).toContain("duplicate");
      expect(result.content[0].text).toContain("Nothing was saved");
      expect(backend.getTodos()).toHaveLength(1);
      expect(backend.saveCalls).toBe(0);
    });

    it("should persist the idempotency key and replay it", async () => {
      const first = await addTodosHandler(backend, {
        todos: ["buy milk"],
        idempotencyKey: "request-1",
      });
      const firstContent = structured<{ added: TodoSummary[] }>(first);
      expect(firstContent.added).toHaveLength(1);

      const [stored] = backend.getTodos();
      expect(stored.tags.idem).toBe("request-1");
      expect(stored.toString()).toContain("idem:request-1");

      const second = await addTodosHandler(backend, {
        todos: ["a different task"],
        idempotencyKey: "request-1",
      });
      const secondContent = structured<{ added: TodoSummary[] }>(second);

      expect(secondContent.added).toEqual(firstContent.added);
      expect(backend.getTodos()).toHaveLength(1);
      expect(backend.saveCalls).toBe(1);
    });

    it("should require a whitespace-free idempotency key", async () => {
      const result = await addTodosHandler(backend, {
        todos: ["task"],
        idempotencyKey: "not a key",
      });
      expect(result).toMatchObject({ isError: true });
      expect(errorOf(result).code).toBe("INVALID_ARGUMENT");
      expect(backend.getTodos()).toHaveLength(0);
    });
  });

  describe("updateTodosHandler", () => {
    it("should edit multiple todos with one save", async () => {
      const initialTodos = [new Todo("first todo"), new Todo("second todo")];
      await backend.save(initialTodos);
      const hash1 = await initialTodos[0].getHash();
      const hash2 = await initialTodos[1].getHash();
      backend.loadCalls = 0;
      backend.saveCalls = 0;

      const result = await updateTodosHandler(backend, {
        edits: [
          { hash: hash1, text: "edited first" },
          { hash: hash2, text: "edited second" },
        ],
      });
      const content = structured<
        { succeeded: TodoSummary[]; failed: BatchFailure[] }
      >(result);

      expect(content.succeeded.map((todo) => todo.text).sort()).toEqual([
        "edited first",
        "edited second",
      ]);
      expect(content.succeeded.every((todo) => todo.status === "todo")).toBe(true);
      expect(content.failed).toEqual([]);
      expect(backend.loadCalls).toBe(1);
      expect(backend.saveCalls).toBe(1);
    });

    it("should reject a full done line instead of corrupting the stored text", async () => {
      const initialTodos = [new Todo("Aardappelen @Colruyt")];
      await backend.save(initialTodos);
      const hash = await initialTodos[0].getHash();
      backend.loadCalls = 0;
      backend.saveCalls = 0;

      const result = await updateTodosHandler(backend, {
        edits: [{
          hash,
          text: "x 2026-11-01 2026-11-01 Aardappelen @Colruyt",
        }],
      });

      expect(result).toMatchObject({ isError: true });
      expect(errorOf(result).code).toBe("INVALID_ARGUMENT");
      expect(errorOf(result).message).toContain("set_todo_statuses");
      expect(backend.getTodos()[0].text).toBe("Aardappelen @Colruyt");
      expect(backend.loadCalls).toBe(0);
      expect(backend.saveCalls).toBe(0);
    });

    it.each([
      ["(A) keep me"],
      ["2026-11-01 keep me"],
    ])("should reject the metadata prefix in %s", async (text) => {
      const initialTodos = [new Todo("keep me")];
      await backend.save(initialTodos);
      const hash = await initialTodos[0].getHash();
      backend.loadCalls = 0;
      backend.saveCalls = 0;

      const result = await updateTodosHandler(backend, {
        edits: [{ hash, text }],
      });

      expect(result).toMatchObject({ isError: true });
      expect(errorOf(result).code).toBe("INVALID_ARGUMENT");
      expect(backend.getTodos()[0].text).toBe("keep me");
      expect(backend.loadCalls).toBe(0);
      expect(backend.saveCalls).toBe(0);
    });

    it("should preview an edit without changing or saving the todo", async () => {
      const initialTodos = [new Todo("original text")];
      await backend.save(initialTodos);
      const hash = await initialTodos[0].getHash();
      backend.loadCalls = 0;
      backend.saveCalls = 0;

      const result = await updateTodosHandler(backend, {
        edits: [{ hash, text: "preview only" }],
        dryRun: true,
      });
      const content = structured<
        { succeeded: TodoSummary[]; failed: BatchFailure[]; dryRun?: boolean }
      >(result);

      expect(content.dryRun).toBe(true);
      expect(content.failed).toEqual([]);
      expect(content.succeeded).toHaveLength(1);
      expect(content.succeeded[0].text).toBe("preview only");
      expect(content.succeeded[0].hash).not.toBe(hash);
      expect(result.content[0].text).toBe(
        `Would edit todo [${content.succeeded[0].hash}]: preview only`,
      );

      // The backend still holds the original, unmutated todo.
      expect(backend.getTodos()).toHaveLength(1);
      expect(backend.getTodos()[0].text).toBe("original text");
      expect(backend.getTodos()[0].toDisplayString()).toBe("original text");
      expect(backend.loadCalls).toBe(1);
      expect(backend.saveCalls).toBe(0);
    });

    it("should report missing hashes in a dry run without saving", async () => {
      await backend.save([new Todo("keep me")]);
      backend.loadCalls = 0;
      backend.saveCalls = 0;

      const result = await updateTodosHandler(backend, {
        edits: [{ hash: "0123456789abcdef", text: "preview only" }],
        dryRun: true,
      });
      const content = structured<
        { succeeded: TodoSummary[]; failed: BatchFailure[]; dryRun?: boolean }
      >(result);

      expect(content.dryRun).toBe(true);
      expect(content.succeeded).toEqual([]);
      expect(content.failed).toEqual([expect.objectContaining({ hash: "0123456789abcdef", code: "TODO_NOT_FOUND" })]);
      expect(result.content[0].text).toBe(
        "Todo with hash 0123456789abcdef not found.",
      );
      expect(backend.getTodos()[0].text).toBe("keep me");
      expect(backend.loadCalls).toBe(1);
      expect(backend.saveCalls).toBe(0);
    });

    it("should return previousHash next to the new hash", async () => {
      const initialTodos = [new Todo("original text")];
      await backend.save(initialTodos);
      const hash = await initialTodos[0].getHash();

      const result = await updateTodosHandler(backend, {
        edits: [{ hash, text: "edited text" }],
      });
      const content = structured<{ succeeded: UpdatedTodoSummary[] }>(result);
      const storedHash = await backend.getTodos()[0].getHash();

      expect(content.succeeded).toHaveLength(1);
      expect(content.succeeded[0].previousHash).toBe(hash);
      expect(content.succeeded[0].hash).toBe(storedHash);
      expect(content.succeeded[0].hash).not.toBe(hash);
    });

    it("should allow chaining an edit into a status change", async () => {
      await backend.save([new Todo("chain me")]);
      const hash = await backend.getTodos()[0].getHash();

      const edited = structured<{ succeeded: UpdatedTodoSummary[] }>(
        await updateTodosHandler(backend, {
          edits: [{ hash, text: "chained edit" }],
        }),
      );

      // No re-list between the two calls: use the hash returned by the edit.
      const statusResult = await setTodoStatusesHandler(backend, {
        hashes: [edited.succeeded[0].hash],
        status: "done",
      });
      const updated = structured<{ succeeded: UpdatedTodoSummary[] }>(
        statusResult,
      );

      expect(updated.succeeded).toHaveLength(1);
      expect(updated.succeeded[0].previousHash).toBe(edited.succeeded[0].hash);
      expect(updated.succeeded[0].hash).not.toBe(edited.succeeded[0].hash);
      expect(backend.getTodos()[0].isDone()).toBe(true);
    });

    it("should return previousHash for a dry run", async () => {
      const initialTodos = [new Todo("original text")];
      await backend.save(initialTodos);
      const hash = await initialTodos[0].getHash();

      const result = await updateTodosHandler(backend, {
        edits: [{ hash, text: "preview only" }],
        dryRun: true,
      });
      const content = structured<{ succeeded: UpdatedTodoSummary[] }>(result);

      expect(content.succeeded).toHaveLength(1);
      expect(content.succeeded[0].previousHash).toBe(hash);
      expect(content.succeeded[0].hash).not.toBe(hash);
      expect(backend.getTodos()[0].text).toBe("original text");
    });
  });

  describe("deleteTodosHandler", () => {
    it("should delete a batch with one load and one save", async () => {
      const initialTodos = [
        new Todo("one"),
        new Todo("two"),
        new Todo("three"),
      ];
      await backend.save(initialTodos);
      const hash1 = await initialTodos[0].getHash();
      const hash3 = await initialTodos[2].getHash();
      backend.loadCalls = 0;
      backend.saveCalls = 0;

      const result = await deleteTodosHandler(backend, {
        hashes: [hash1, hash3, "0123456789abcdef"],
      });
      const content = structured<
        { succeeded: TodoSummary[]; failed: BatchFailure[] }
      >(result);

      expect(content.succeeded).toEqual([
        { hash: hash1, text: "one", status: "todo" },
        {
          hash: hash3,
          text: "three",
          status: "todo",
        },
      ]);
      expect(content.failed).toEqual([expect.objectContaining({ hash: "0123456789abcdef", code: "TODO_NOT_FOUND" })]);
      expect(backend.getTodos().map((todo) => todo.text)).toEqual(["two"]);
      expect(backend.loadCalls).toBe(1);
      expect(backend.saveCalls).toBe(1);
    });

    it("should reject the whole batch before touching the backend", async () => {
      await backend.save([new Todo("keep me")]);
      backend.loadCalls = 0;
      backend.saveCalls = 0;

      const result = await deleteTodosHandler(backend, {
        hashes: ["0123456789abcdef", "short"],
      });
      expect(result).toMatchObject({ isError: true });
      expect(errorOf(result).code).toBe("INVALID_ARGUMENT");

      expect(backend.getTodos()).toHaveLength(1);
      expect(backend.loadCalls).toBe(0);
      expect(backend.saveCalls).toBe(0);
    });

    it("should not save when no hash matches", async () => {
      await backend.save([new Todo("keep me")]);
      backend.loadCalls = 0;
      backend.saveCalls = 0;

      const result = await deleteTodosHandler(backend, {
        hashes: ["0123456789abcdef"],
      });
      const content = structured<
        { succeeded: TodoSummary[]; failed: BatchFailure[] }
      >(result);

      expect(content.succeeded).toEqual([]);
      expect(content.failed).toEqual([expect.objectContaining({ hash: "0123456789abcdef", code: "TODO_NOT_FOUND" })]);
      expect(backend.getTodos()).toHaveLength(1);
      expect(backend.loadCalls).toBe(1);
      expect(backend.saveCalls).toBe(0);
    });
  });

  describe("setTodoStatusesHandler", () => {
    it("should update a batch with one load and one save", async () => {
      const initialTodos = [new Todo("one"), new Todo("two")];
      await backend.save(initialTodos);
      const hash1 = await initialTodos[0].getHash();
      const hash2 = await initialTodos[1].getHash();
      backend.loadCalls = 0;
      backend.saveCalls = 0;

      const result = await setTodoStatusesHandler(backend, {
        hashes: [hash1, hash2, "0123456789abcdef"],
        status: "done",
      });
      const content = structured<
        { succeeded: TodoSummary[]; failed: BatchFailure[] }
      >(result);

      expect(content.succeeded).toHaveLength(2);
      expect(content.succeeded.every((todo) => todo.status === "done")).toBe(
        true,
      );
      expect(content.failed).toEqual([expect.objectContaining({ hash: "0123456789abcdef", code: "TODO_NOT_FOUND" })]);
      expect(backend.getTodos().every((todo) => todo.isDone())).toBe(true);
      expect(backend.loadCalls).toBe(1);
      expect(backend.saveCalls).toBe(1);
    });

    it("should not save when no hash matches", async () => {
      await backend.save([new Todo("keep me")]);
      backend.saveCalls = 0;

      await setTodoStatusesHandler(backend, {
        hashes: ["0123456789abcdef"],
        status: "done",
      });

      expect(backend.getTodos()[0].isDone()).toBe(false);
      expect(backend.saveCalls).toBe(0);
    });

    it("should preview a status change without changing or saving the todo", async () => {
      const initialTodos = [new Todo("one")];
      await backend.save(initialTodos);
      const hash = await initialTodos[0].getHash();
      backend.loadCalls = 0;
      backend.saveCalls = 0;

      const result = await setTodoStatusesHandler(backend, {
        hashes: [hash],
        status: "done",
        dryRun: true,
      });
      const content = structured<
        { succeeded: TodoSummary[]; failed: BatchFailure[]; dryRun?: boolean }
      >(result);

      expect(content.dryRun).toBe(true);
      expect(content.failed).toEqual([]);
      expect(content.succeeded).toHaveLength(1);
      expect(content.succeeded[0].status).toBe("done");
      expect(result.content[0].text).toBe(
        `Would set todo [${content.succeeded[0].hash}] status to done: x one`,
      );

      // The backend still holds the original, unmutated todo.
      expect(backend.getTodos()).toHaveLength(1);
      expect(backend.getTodos()[0].isDone()).toBe(false);
      expect(backend.loadCalls).toBe(1);
      expect(backend.saveCalls).toBe(0);
    });

    it("should not append a recurrence follow-up during a dry run", async () => {
      const recurring = new Todo("water plants rec:1w");
      await backend.save([recurring]);
      const hash = await recurring.getHash();
      backend.loadCalls = 0;
      backend.saveCalls = 0;

      const result = await setTodoStatusesHandler(backend, {
        hashes: [hash],
        status: "done",
        dryRun: true,
      });
      const content = structured<
        { succeeded: TodoSummary[]; failed: BatchFailure[]; dryRun?: boolean }
      >(result);

      expect(content.dryRun).toBe(true);
      expect(content.succeeded).toHaveLength(1);
      expect(content.succeeded[0].status).toBe("done");
      expect(result.content[0].text).toContain("Would set todo");
      expect(backend.getTodos()).toHaveLength(1);
      expect(backend.getTodos()[0].isDone()).toBe(false);
      expect(backend.loadCalls).toBe(1);
      expect(backend.saveCalls).toBe(0);
    });

    it("should return previousHash next to the new hash", async () => {
      await backend.save([new Todo("one")]);
      const hash = await backend.getTodos()[0].getHash();

      const result = await setTodoStatusesHandler(backend, {
        hashes: [hash],
        status: "done",
      });
      const content = structured<{ succeeded: UpdatedTodoSummary[] }>(result);
      const storedHash = await backend.getTodos()[0].getHash();

      expect(content.succeeded).toHaveLength(1);
      expect(content.succeeded[0].previousHash).toBe(hash);
      expect(content.succeeded[0].hash).toBe(storedHash);
      expect(content.succeeded[0].hash).not.toBe(hash);
    });

    it("should return previousHash for a dry run", async () => {
      await backend.save([new Todo("one")]);
      const hash = await backend.getTodos()[0].getHash();

      const result = await setTodoStatusesHandler(backend, {
        hashes: [hash],
        status: "done",
        dryRun: true,
      });
      const content = structured<{ succeeded: UpdatedTodoSummary[] }>(result);

      expect(content.succeeded).toHaveLength(1);
      expect(content.succeeded[0].previousHash).toBe(hash);
      expect(content.succeeded[0].hash).not.toBe(hash);
      expect(backend.getTodos()[0].isDone()).toBe(false);
    });
  });

  describe("deleteCompletedHandler", () => {
    it("should delete completed todos before a date in a context", async () => {
      const old = new Todo("x 2025-01-01 2024-12-01 Old done @Home");
      const boundary = new Todo("x 2026-01-01 2025-12-01 Boundary done @home");
      const recent = new Todo("x 2026-05-01 2026-04-01 Recent done @Work");
      const active = new Todo("active @home");
      await backend.save([old, boundary, recent, active]);
      const oldHash = await old.getHash();
      backend.saveCalls = 0;

      const result = await deleteCompletedHandler(backend, {
        before: "2026-01-01",
        context: "@HOME",
      });
      const content = structured<{ deletedCount: number; hashes: string[] }>(
        result,
      );

      expect(content).toEqual({ deletedCount: 1, hashes: [oldHash] });
      expect(backend.getTodos().map((todo) => todo.text).sort()).toEqual([
        "Boundary done @home",
        "Recent done @Work",
        "active @home",
      ].sort());
      expect(backend.saveCalls).toBe(1);
    });

    it("should match contexts case-insensitively without the @ prefix", async () => {
      const first = new Todo("x 2025-01-01 2024-12-01 first @Home");
      const second = new Todo("x 2026-05-01 2026-04-01 second @home");
      const other = new Todo("x 2025-01-01 2024-12-01 third @Work");
      await backend.save([first, second, other]);

      const result = await deleteCompletedHandler(backend, {
        context: "HOME",
      });
      const content = structured<{ deletedCount: number; hashes: string[] }>(
        result,
      );

      expect(content.deletedCount).toBe(2);
      expect(content.hashes).toHaveLength(2);
      expect(backend.getTodos().map((todo) => todo.text)).toEqual([
        "third @Work",
      ]);
    });

    it("should be a no-op when nothing matches", async () => {
      await backend.save([
        new Todo("x 2025-01-01 2024-12-01 done @home"),
        new Todo("active"),
      ]);
      backend.loadCalls = 0;
      backend.saveCalls = 0;

      const result = await deleteCompletedHandler(backend, {
        before: "2000-01-01",
      });
      const content = structured<{ deletedCount: number; hashes: string[] }>(
        result,
      );

      expect(content).toEqual({ deletedCount: 0, hashes: [] });
      expect(backend.getTodos()).toHaveLength(2);
      expect(backend.loadCalls).toBe(1);
      expect(backend.saveCalls).toBe(0);
    });

    it("should delete every completed todo when no filter is given", async () => {
      await backend.save([
        new Todo("x 2025-01-01 2024-12-01 first"),
        new Todo("x 2026-05-01 2026-04-01 second @work"),
        new Todo("active"),
      ]);

      const result = await deleteCompletedHandler(backend, {});
      const content = structured<{ deletedCount: number; hashes: string[] }>(
        result,
      );

      expect(content.deletedCount).toBe(2);
      expect(backend.getTodos().map((todo) => todo.text)).toEqual(["active"]);
    });

    it("should reject invalid dates", async () => {
      for (const before of ["2026-02-30", "01-02-2026"]) {
        const result = await deleteCompletedHandler(backend, { before });
        expect(result).toMatchObject({ isError: true });
        expect(errorOf(result).code).toBe("INVALID_ARGUMENT");
      }
    });
  });

  describe("Full flow scenarios", () => {
    it("should handle the full add-edit-markdone cycle", async () => {
      // 1. Add a todo
      const addArgs = {
        todos: ["Test Hash Todo"],
      };
      await addTodoHandler(backend, addArgs);
      const initialTodos = backend.getTodos();
      expect(initialTodos.length).toBe(1);
      const todo = initialTodos[0];
      const originalHash = await todo.getHash();

      // 2. Edit the todo
      const editArgs = {
        edits: [{ hash: originalHash, text: "Test Hash Todo Edited" }],
      };
      await editTodoHandler(backend, editArgs);
      const editedTodos = backend.getTodos();
      expect(editedTodos.length).toBe(1);
      expect(editedTodos[0].text).toBe("Test Hash Todo Edited");
      const editedHash = await editedTodos[0].getHash();

      // 3. Mark the todo as done
      const doneArgs = { hash: editedHash, status: "done" };
      await setTodoStatusHandler(backend, doneArgs);

      // 4. Verify final state
      const finalTodos = backend.getTodos();
      expect(finalTodos.length).toBe(1);
      const doneTodo = finalTodos[0];
      expect(doneTodo.state).toBe(TodoStateEnum.done);
      expect(doneTodo.text).toBe("Test Hash Todo Edited");

      // Verify using listTodosHandler
      const listArgs = { status: "done", format: "both" };
      const listResult = await listTodosHandler(backend, listArgs);
      const text = listResult.content[0].text as string;

      const doneHash = await doneTodo!.getHash();
      expect(text.includes(`[${doneHash}] x`)).toBe(true);
      expect(text.includes("Test Hash Todo Edited")).toBe(true);
    });
  });
});
