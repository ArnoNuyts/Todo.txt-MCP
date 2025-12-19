import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  beforeEach,
  describe,
  it,
} from "https://deno.land/std@0.224.0/testing/bdd.ts";
import { Todo } from "../logic/todo.ts";
import { TodoBackend } from "../logic/backend.ts";
import {
  addTodoHandler,
  editTodoHandler,
  listTodosHandler,
  setTodoStatusHandler,
} from "../server.ts";
import { TodoStateEnum } from "../types/enums.ts";

// Mock backend
class MockBackend implements TodoBackend {
  private _todos: Todo[] = [];

  load(): Promise<Todo[]> {
    return Promise.resolve(this._todos);
  }

  save(todos: Todo[]): Promise<void> {
    this._todos = todos;
    return Promise.resolve();
  }

  getTodos(): Todo[] {
    return this._todos;
  }

  reset() {
    this._todos = [];
  }
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
      assertEquals(storedTodos.length, 1);
      assertEquals(storedTodos[0].text, "first todo");

      const todo1Hash = await storedTodos[0].getHash();
      const expectedText = `Added todo [${todo1Hash}]: ${
        storedTodos[0].toDisplayString()
      }`;

      assertEquals(result.content[0].text, expectedText);
    });

    it("should add multiple todos", async () => {
      const args = {
        todos: ["first todo", "second todo"],
      };
      const result = await addTodoHandler(backend, args);

      const storedTodos = backend.getTodos();
      assertEquals(storedTodos.length, 2);
      assertEquals(storedTodos[0].text, "first todo");
      assertEquals(storedTodos[1].text, "second todo");

      const todo1Hash = await storedTodos[0].getHash();
      const todo2Hash = await storedTodos[1].getHash();

      const newTodoStrings = [
        `Added todo [${todo1Hash}]: ${storedTodos[0].toDisplayString()}`,
        `Added todo [${todo2Hash}]: ${storedTodos[1].toDisplayString()}`,
      ];

      assertEquals(result.content[0].text, newTodoStrings.join("\n"));
    });

    it("should handle adding to an existing list of todos", async () => {
      // Pre-populate backend
      await backend.save([new Todo("existing todo")]);

      const args = {
        todos: ["new todo"],
      };
      await addTodoHandler(backend, args);

      const storedTodos = backend.getTodos();
      assertEquals(storedTodos.length, 2);
      assertEquals(storedTodos[0].text, "existing todo");
      assertEquals(storedTodos[1].text, "new todo");
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
      assertEquals(storedTodos.length, 1);
      assertEquals(storedTodos[0].text, "edited text");

      const newHash = await storedTodos[0].getHash();
      assertEquals(
        result.content[0].text,
        `Edited todo [${newHash}]: ${storedTodos[0].toDisplayString()}`,
      );
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
      assertEquals(storedTodos.length, 2);
      // order is not guaranteed.
      const texts = storedTodos.map((t) => t.text).sort();
      assertEquals(texts, ["edited first", "edited second"]);
    });

    it("should return an error if a hash is not found", async () => {
      await backend.save([new Todo("a todo")]);

      const args = {
        edits: [{ hash: "nonexistent", text: "new text" }],
      };

      const result = await editTodoHandler(backend, args);

      assertEquals(
        result.content[0].text,
        "Todo with hash nonexistent not found.",
      );

      // And the valid todo should not be changed
      const storedTodos = backend.getTodos();
      assertEquals(storedTodos.length, 1);
      assertEquals(storedTodos[0].text, "a todo");
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

      assertEquals(resultingTexts, expectedTexts);

      // Check stored todos
      assertEquals(storedTodos[0].text, "edited text");
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
      assertEquals(text.includes("Active Task 1"), true);
      assertEquals(text.includes("Done Task 1"), false);
    });

    it("should return only done todos when status is 'done'", async () => {
      const result = await listTodosHandler(backend, { status: "done" });
      const text = result.content[0].text as string;
      assertEquals(text.includes("Active Task 1"), false);
      assertEquals(text.includes("Done Task 1"), true);
    });

    it("should return all todos when status is 'all'", async () => {
      const result = await listTodosHandler(backend, { status: "all" });
      const text = result.content[0].text as string;
      assertEquals(text.includes("Active Task 1"), true);
      assertEquals(text.includes("Done Task 1"), true);
    });

    it("should filter todos by search term", async () => {
      const result = await listTodosHandler(backend, {
        search: "UniqueSearchTerm",
      });
      const text = result.content[0].text as string;
      assertEquals(text.includes("UniqueSearchTerm"), true);
      assertEquals(text.includes("Active Task 1"), false);
    });

    it("should apply pagination limit", async () => {
      const result = await listTodosHandler(backend, { limit: 1 });
      const text = result.content[0].text as string;
      const lines = text.split("\n").filter((l) => l.trim() !== "");
      assertEquals(lines.length, 1);
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
      assertEquals(initialTodos.length, 1);
      const todo = initialTodos[0];
      const originalHash = await todo.getHash();

      // 2. Edit the todo
      const editArgs = {
        edits: [{ hash: originalHash, text: "Test Hash Todo Edited" }],
      };
      await editTodoHandler(backend, editArgs);
      const editedTodos = backend.getTodos();
      assertEquals(editedTodos.length, 1);
      assertEquals(editedTodos[0].text, "Test Hash Todo Edited");
      const editedHash = await editedTodos[0].getHash();


      // 3. Mark the todo as done
      const doneArgs = { hash: editedHash, status: "done" };
      await setTodoStatusHandler(backend, doneArgs);

      // 4. Verify final state
      const finalTodos = backend.getTodos();
      assertEquals(finalTodos.length, 1);
      const doneTodo = finalTodos[0];
      assertEquals(doneTodo.state, TodoStateEnum.done);
      assertEquals(doneTodo.text, "Test Hash Todo Edited");

      // Verify using listTodosHandler
      const listArgs = { status: "done" };
      const listResult = await listTodosHandler(backend, listArgs);
      const text = listResult.content[0].text as string;

      const doneHash = await doneTodo!.getHash();
      assertEquals(text.includes(`[${doneHash}] x`), true);
      assertEquals(text.includes("Test Hash Todo Edited"), true);
    });
  });
});
