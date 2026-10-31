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
    new RegExp(`${action} todo \\[([0-9a-f]{16})\\]`),
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

  it("should expose the five todo tools", async () => {
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "add_todo",
      "delete_todo",
      "edit_todo",
      "list_todos",
      "set_todo_status",
    ]);
  });

  it("should expose annotations and output schemas for each tool", async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    expect(byName.get("list_todos")?.annotations).toMatchObject({
      readOnlyHint: true,
    });
    expect(byName.get("add_todo")?.annotations).toMatchObject({
      destructiveHint: false,
      idempotentHint: false,
    });
    expect(byName.get("edit_todo")?.annotations).toMatchObject({
      destructiveHint: true,
      idempotentHint: false,
    });
    expect(byName.get("set_todo_status")?.annotations).toMatchObject({
      destructiveHint: true,
      idempotentHint: true,
    });
    expect(byName.get("delete_todo")?.annotations).toMatchObject({
      destructiveHint: true,
      idempotentHint: true,
    });

    for (const tool of tools) {
      expect(tool.outputSchema, `${tool.name} output schema`).toBeDefined();
    }
  });

  it("should return structured content for each tool", async () => {
    const addResult = await client.callTool({
      name: "add_todo",
      arguments: { todos: ["structured todo"] },
    }) as { structuredContent?: { added: Array<{ hash: string }> } };
    expect(addResult.structuredContent?.added).toHaveLength(1);
    const hash = addResult.structuredContent!.added[0].hash;
    expect(hash).toMatch(/^[0-9a-f]{16}$/);

    const listResult = await client.callTool({
      name: "list_todos",
      arguments: {},
    }) as {
      structuredContent?: {
        todos: Array<{ hash: string; text: string; state: number }>;
        total: number;
        nextOffset: number | null;
      };
    };
    expect(listResult.structuredContent).toMatchObject({
      total: 1,
      nextOffset: null,
    });
    expect(listResult.structuredContent?.todos[0]).toMatchObject({
      hash,
      text: "structured todo",
      state: 1,
    });

    const editResult = await client.callTool({
      name: "edit_todo",
      arguments: {
        edits: [{ hash, text: "structured todo edited" }],
      },
    }) as {
      structuredContent?: {
        edited: Array<{ hash: string; text: string }>;
        missing: string[];
      };
    };
    expect(editResult.structuredContent?.missing).toEqual([]);
    const edited = editResult.structuredContent!.edited[0];
    expect(edited.text).toBe("structured todo edited");

    const statusResult = await client.callTool({
      name: "set_todo_status",
      arguments: { hash: edited.hash, status: "done" },
    }) as {
      structuredContent?: { hash: string; status: string; text: string };
    };
    expect(statusResult.structuredContent).toMatchObject({
      status: "done",
      text: expect.stringContaining("structured todo edited"),
    });
  });

  it("should delete a todo by hash", async () => {
    const addResult = await client.callTool({
      name: "add_todo",
      arguments: { todos: ["delete me"] },
    });
    const hash = firstHash(addResult, "Added");

    const deleteResult = await client.callTool({
      name: "delete_todo",
      arguments: { hash },
    }) as {
      isError?: boolean;
      structuredContent?: { deleted: boolean; hash: string };
    };

    expect(deleteResult.isError).not.toBe(true);
    expect(deleteResult.structuredContent).toEqual({ deleted: true, hash });
    expect(textOf(deleteResult)).toBe(`Deleted todo [${hash}]`);
    expect(backend.getTodos()).toHaveLength(0);

    const missingResult = await client.callTool({
      name: "delete_todo",
      arguments: { hash },
    }) as { isError?: boolean };

    expect(missingResult.isError).toBe(true);
    expect(textOf(missingResult)).toBe("Todo not found (file modified?)");
  });

  it("should expose a todo_format prompt with a user message", async () => {
    const result = await client.getPrompt({ name: "todo_format" });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content).toMatchObject({ type: "text" });
    const content = result.messages[0].content as { text: string };
    expect(content.text).toContain("todo.txt");
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
