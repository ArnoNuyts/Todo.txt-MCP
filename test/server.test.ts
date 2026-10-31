import { beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Todo } from "../logic/todo.ts";
import {
  addTodoHandler,
  deleteTodoHandler,
  editTodoHandler,
  listTodosHandler,
  setTodoStatusHandler,
} from "../server.ts";
import { TodoStateEnum } from "../types/enums.ts";
import { LocalFileBackend } from "../logic/backends/local-file-backend.ts";
import { MockBackend } from "./helpers/mock-backend.ts";

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
        }],
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

      await expect(addTodoHandler(backend, args)).rejects.toThrow();
      expect(backend.getTodos()).toHaveLength(0);
    });

    it("should reject an overlong todo", async () => {
      await expect(
        addTodoHandler(backend, { todos: ["a".repeat(2001)] }),
      ).rejects.toThrow();
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
        edited: [{
          hash: newHash,
          text: storedTodos[0].toDisplayString(),
        }],
        missing: [],
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
        edited: [{
          hash: newHash,
          text: storedTodos[0].toDisplayString(),
        }],
        missing: ["nonexistent"],
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
      const result = await listTodosHandler(backend, {});
      const text = result.content[0].text as string;
      expect(text.includes("Active Task 1")).toBe(true);
      expect(text.includes("Done Task 1")).toBe(false);
      expect(result.structuredContent).toMatchObject({
        total: 3,
        nextOffset: null,
      });
    });

    it("should return only done todos when status is 'done'", async () => {
      const result = await listTodosHandler(backend, { status: "done" });
      const text = result.content[0].text as string;
      expect(text.includes("Active Task 1")).toBe(false);
      expect(text.includes("Done Task 1")).toBe(true);
    });

    it("should return all todos when status is 'all'", async () => {
      const result = await listTodosHandler(backend, { status: "all" });
      const text = result.content[0].text as string;
      expect(text.includes("Active Task 1")).toBe(true);
      expect(text.includes("Done Task 1")).toBe(true);
    });

    it("should filter todos by search term", async () => {
      const result = await listTodosHandler(backend, {
        search: "UniqueSearchTerm",
      });
      const text = result.content[0].text as string;
      expect(text.includes("UniqueSearchTerm")).toBe(true);
      expect(text.includes("Active Task 1")).toBe(false);
    });

    it("should apply pagination limit", async () => {
      const result = await listTodosHandler(backend, { limit: 1 });
      const text = result.content[0].text as string;
      const lines = text.split("\n").filter((l) => l.trim() !== "");
      expect(lines.length).toBe(1);
      expect(result.structuredContent).toMatchObject({
        total: 3,
        nextOffset: 1,
      });
    });

    it("should include todo details in structured content", async () => {
      const result = await listTodosHandler(backend, { status: "all" });
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
      expect(done!.state).toBe(TodoStateEnum.done);
      expect(done!.hash).toMatch(/^[0-9a-f]{16}$/);
    });

    it("should reject an out-of-range limit", async () => {
      await expect(listTodosHandler(backend, { limit: 0 })).rejects.toThrow();
      await expect(listTodosHandler(backend, { limit: 501 })).rejects.toThrow();
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
      expect(result.structuredContent).toEqual({
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
      expect(result.content[0].text).toBe("Todo not found (file modified?)");

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
      expect(result.structuredContent).toEqual({ deleted: true, hash });

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
      expect(result.content[0].text).toBe("Todo not found (file modified?)");

      const storedTodos = backend.getTodos();
      expect(storedTodos).toHaveLength(1);
      expect(storedTodos[0].text).toBe("keep me");
    });

    it("should reject a hash outside the allowed length", async () => {
      await expect(deleteTodoHandler(backend, { hash: "short" })).rejects
        .toThrow();
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
      const listArgs = { status: "done" };
      const listResult = await listTodosHandler(backend, listArgs);
      const text = listResult.content[0].text as string;

      const doneHash = await doneTodo!.getHash();
      expect(text.includes(`[${doneHash}] x`)).toBe(true);
      expect(text.includes("Test Hash Todo Edited")).toBe(true);
    });
  });
});
