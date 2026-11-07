import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTodoMcpServer } from "../server.ts";
import { Todo } from "../logic/todo.ts";
import { MockBackend } from "./helpers/mock-backend.ts";

interface ToolTextResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: { error?: { code?: string } };
}

function textOf(result: unknown): string {
  return (result as ToolTextResult).content
    .map((item) => item.text ?? "")
    .join("\n");
}

function linesOf(result: unknown): string[] {
  return textOf(result).split("\n");
}

function errorCodeOf(result: unknown): string | undefined {
  return (result as ToolTextResult).structuredContent?.error?.code;
}

describe("duplicate policy", () => {
  let backend: MockBackend;
  let client: Client;
  let server: ReturnType<typeof createTodoMcpServer>;

  beforeEach(async () => {
    backend = new MockBackend();
    server = createTodoMcpServer(backend);
    const [clientTransport, serverTransport] = InMemoryTransport
      .createLinkedPair();
    client = new Client({
      name: "todo-txt-mcp-duplicate-test",
      version: "1.0.0",
    });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
  });

  afterEach(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });

  async function add(
    todos: string[],
    onDuplicate?: "allow" | "skip" | "error",
  ) {
    return await client.callTool({
      name: "add_todos",
      arguments: onDuplicate === undefined ? { todos } : { todos, onDuplicate },
    });
  }

  async function hashOf(todo: Todo): Promise<string> {
    return await todo.getHash();
  }

  describe("add_todos", () => {
    it("allows duplicates by default", async () => {
      await add(["Dup"]);
      const result = await add(["Dup"]);

      expect(result.isError).toBeFalsy();
      expect(linesOf(result)).toHaveLength(1);
      expect(backend.getTodos()).toHaveLength(2);
    });

    it("skips a duplicate that already exists", async () => {
      await add(["Dup"]);
      backend.saveCalls = 0;

      const result = await add(["Dup"], "skip");

      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain("SKIPPED Dup");
      expect(backend.getTodos()).toHaveLength(1);
      expect(backend.saveCalls).toBe(0);
    });

    it("fails the whole batch when a duplicate exists and policy is error", async () => {
      await add(["Dup"]);
      backend.saveCalls = 0;

      const result = await add(["New", "Dup"], "error");

      expect(result.isError).toBe(true);
      expect(errorCodeOf(result)).toBe("CONFLICT");
      expect(backend.getTodos()).toHaveLength(1);
      expect(backend.getTodos()[0].text).toBe("Dup");
      expect(backend.saveCalls).toBe(0);
    });

    it("skips only the duplicate within one batch", async () => {
      const result = await add(["New", "Dup", "Dup"], "skip");

      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain("SKIPPED Dup");
      expect(backend.getTodos()).toHaveLength(2);
      expect(backend.getTodos().filter((todo) => todo.text === "Dup"))
        .toHaveLength(1);
    });

    it("fails a batch with an internal duplicate when policy is error", async () => {
      backend.saveCalls = 0;

      const result = await add(["Dup", "Dup"], "error");

      expect(result.isError).toBe(true);
      expect(errorCodeOf(result)).toBe("CONFLICT");
      expect(backend.saveCalls).toBe(0);
      expect(backend.getTodos()).toHaveLength(0);
    });

    it("keeps raw-distinct lines separate instead of calling them duplicates", async () => {
      await backend.save([
        new Todo("2026-11-07 Dup due:2024-06-30 tail"),
      ]);
      backend.saveCalls = 0;

      const result = await add(["2026-11-07 Dup tail due:2024-06-30"], "skip");

      expect(result.isError).toBeFalsy();
      expect(textOf(result)).not.toContain("SKIPPED");
      expect(backend.getTodos()).toHaveLength(2);
      expect(backend.saveCalls).toBe(1);
    });
  });

  describe("update_todos", () => {
    it("allows an update that creates a duplicate by default", async () => {
      const other = new Todo("Other");
      await backend.save([other, new Todo("Dup")]);
      const hash = await hashOf(other);

      const result = await client.callTool({
        name: "update_todos",
        arguments: { updates: [`${hash} Dup`] },
      });

      expect(result.isError).toBeFalsy();
      expect(backend.getTodos().filter((todo) => todo.text === "Dup"))
        .toHaveLength(2);
    });

    it("skips an update that would create a duplicate", async () => {
      const other = new Todo("Other");
      await backend.save([other, new Todo("Dup")]);
      const hash = await hashOf(other);
      backend.saveCalls = 0;

      const result = await client.callTool({
        name: "update_todos",
        arguments: { updates: [`${hash} Dup`], onDuplicate: "skip" },
      });

      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain(`SKIPPED ${hash} Dup`);
      expect(textOf(result)).toContain("0 updated, 1 skipped");
      expect(backend.getTodos().map((todo) => todo.toString())).toEqual([
        "Other",
        "Dup",
      ]);
      expect(backend.saveCalls).toBe(0);
    });

    it("fails the whole batch when an update would create a duplicate", async () => {
      const other = new Todo("Other");
      await backend.save([other, new Todo("Dup")]);
      const hash = await hashOf(other);
      backend.saveCalls = 0;

      const result = await client.callTool({
        name: "update_todos",
        arguments: { updates: [`${hash} Dup`], onDuplicate: "error" },
      });

      expect(result.isError).toBe(true);
      expect(errorCodeOf(result)).toBe("CONFLICT");
      expect(backend.getTodos().map((todo) => todo.toString())).toEqual([
        "Other",
        "Dup",
      ]);
      expect(backend.saveCalls).toBe(0);
    });

    it("skips an update that would duplicate an earlier update in the batch", async () => {
      const first = new Todo("First");
      const second = new Todo("Second");
      await backend.save([first, second]);
      const firstHash = await hashOf(first);
      const secondHash = await hashOf(second);
      backend.saveCalls = 0;

      const result = await client.callTool({
        name: "update_todos",
        arguments: {
          updates: [`${firstHash} Shared`, `${secondHash} Shared`],
          onDuplicate: "skip",
        },
      });

      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain("1 updated, 1 skipped");
      expect(backend.getTodos().map((todo) => todo.toString())).toEqual([
        "Shared",
        "Second",
      ]);
      expect(backend.saveCalls).toBe(1);
    });

    it("does not treat a no-op update as a duplicate", async () => {
      const todos = [new Todo("Dup"), new Todo("Dup")];
      await backend.save(todos);
      const hash = await hashOf(todos[0]);
      backend.saveCalls = 0;

      const result = await client.callTool({
        name: "update_todos",
        arguments: { updates: [`${hash} Dup`], onDuplicate: "error" },
      });

      expect(result.isError).toBeFalsy();
      expect(backend.saveCalls).toBe(0);
    });
  });

  describe("first matching duplicate", () => {
    it("updates only the first identical line and can be repeated", async () => {
      const todos = [new Todo("Dup"), new Todo("Dup"), new Todo("Other")];
      await backend.save(todos);
      const hash = await hashOf(todos[0]);
      backend.saveCalls = 0;

      const first = await client.callTool({
        name: "update_todos",
        arguments: { updates: [`${hash} (A) Dup`] },
      });
      expect(first.isError).toBeFalsy();
      expect(linesOf(first)).toHaveLength(1);
      expect(backend.getTodos().map((todo) => todo.toString())).toEqual([
        "(A) Dup",
        "Dup",
        "Other",
      ]);
      expect(backend.saveCalls).toBe(1);

      const second = await client.callTool({
        name: "update_todos",
        arguments: { updates: [`${hash} (B) Dup`] },
      });
      expect(second.isError).toBeFalsy();
      expect(backend.getTodos().map((todo) => todo.toString())).toEqual([
        "(A) Dup",
        "(B) Dup",
        "Other",
      ]);
      expect(backend.saveCalls).toBe(2);
    });

    it("deletes only the first identical line and can be repeated", async () => {
      const todos = [new Todo("Dup"), new Todo("Dup"), new Todo("Other")];
      await backend.save(todos);
      const hash = await hashOf(todos[0]);
      backend.saveCalls = 0;

      const first = await client.callTool({
        name: "delete_todos",
        arguments: { hashes: [hash] },
      });
      expect(first.isError).toBeFalsy();
      expect(linesOf(first)).toHaveLength(1);
      expect(backend.getTodos().map((todo) => todo.toString())).toEqual([
        "Dup",
        "Other",
      ]);
      expect(backend.saveCalls).toBe(1);

      const second = await client.callTool({
        name: "delete_todos",
        arguments: { hashes: [hash] },
      });
      expect(second.isError).toBeFalsy();
      expect(backend.getTodos().map((todo) => todo.toString())).toEqual([
        "Other",
      ]);

      const third = await client.callTool({
        name: "delete_todos",
        arguments: { hashes: [hash] },
      });
      expect(errorCodeOf(third)).toBe("TODO_NOT_FOUND");
    });
  });
});
