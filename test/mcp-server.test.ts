import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTodoMcpServer } from "../server.ts";
import { MockBackend } from "./helpers/mock-backend.ts";

/** Shape of the tool results this server returns. */
interface ToolTextResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}

function textOf(result: unknown): string {
  const { content } = result as ToolTextResult;
  return content.map((item) => item.text ?? "").join("\n");
}

function firstHash(result: unknown, action: "Added" | "Edited"): string {
  const match = textOf(result).match(
    new RegExp(`${action} todo \\[([0-9a-f]{8})\\]`),
  );
  if (!match) {
    throw new Error(`No ${action} todo hash in: ${textOf(result)}`);
  }
  return match[1];
}

describe("createTodoMcpServer", () => {
  let backend: MockBackend;
  let client: Client;
  let server: ReturnType<typeof createTodoMcpServer>;

  beforeEach(async () => {
    backend = new MockBackend();
    server = createTodoMcpServer(backend);
    const [clientTransport, serverTransport] = InMemoryTransport
      .createLinkedPair();
    client = new Client({
      name: "todo-txt-mcp-test-client",
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

  it("should expose the four todo tools", async () => {
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "add_todo",
      "edit_todo",
      "list_todos",
      "set_todo_status",
    ]);
  });

  it("should support an add -> list -> edit -> set_todo_status flow", async () => {
    // add_todo
    const addResult = await client.callTool({
      name: "add_todo",
      arguments: { todos: ["write tests"] },
    });
    const addedHash = firstHash(addResult, "Added");
    expect(textOf(addResult)).toContain("write tests");

    // list_todos
    const listResult = await client.callTool({
      name: "list_todos",
      arguments: {},
    });
    expect(textOf(listResult)).toContain(addedHash);
    expect(textOf(listResult)).toContain("write tests");

    // edit_todo
    const editResult = await client.callTool({
      name: "edit_todo",
      arguments: {
        edits: [{ hash: addedHash, text: "write more tests" }],
      },
    });
    expect(textOf(editResult)).toContain("write more tests");
    const editedHash = firstHash(editResult, "Edited");

    // set_todo_status
    const statusResult = await client.callTool({
      name: "set_todo_status",
      arguments: { hash: editedHash, status: "done" },
    });
    expect(statusResult.isError).not.toBe(true);
    expect(textOf(statusResult)).toContain("status to done");

    // The backend reflects the completed todo.
    const storedTodos = backend.getTodos();
    expect(storedTodos.length).toBe(1);
    expect(storedTodos[0].isDone()).toBe(true);
    expect(storedTodos[0].text).toBe("write more tests");

    // ...and listing done todos shows it.
    const doneList = await client.callTool({
      name: "list_todos",
      arguments: { status: "done" },
    });
    // Completing the todo changes its text (and therefore its hash).
    const doneHash = await storedTodos[0].getHash();
    expect(textOf(doneList)).toContain(`[${doneHash}] x`);
    expect(textOf(doneList)).toContain("write more tests");
  });
});
