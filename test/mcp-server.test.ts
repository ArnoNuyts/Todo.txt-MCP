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

  it("should expose the canonical tools plus deprecated aliases", async () => {
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "add_todo",
      "add_todos",
      "delete_completed",
      "delete_todo",
      "delete_todos",
      "edit_todo",
      "list_todos",
      "set_todo_status",
      "set_todo_statuses",
      "update_todos",
    ]);

    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of ["add_todo", "edit_todo", "delete_todo", "set_todo_status"]) {
      expect(byName.get(name)?.description).toContain("Deprecated");
    }
  });

  it("should expose annotations and output schemas for each tool", async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    expect(byName.get("list_todos")?.annotations).toMatchObject({
      readOnlyHint: true,
    });
    expect(byName.get("add_todos")?.annotations).toMatchObject({
      destructiveHint: false,
      idempotentHint: false,
    });
    expect(byName.get("update_todos")?.annotations).toMatchObject({
      destructiveHint: true,
      idempotentHint: false,
    });
    expect(byName.get("set_todo_statuses")?.annotations).toMatchObject({
      destructiveHint: true,
      idempotentHint: true,
    });
    expect(byName.get("delete_todos")?.annotations).toMatchObject({
      destructiveHint: true,
      idempotentHint: true,
    });
    expect(byName.get("delete_completed")?.annotations).toMatchObject({
      destructiveHint: true,
      idempotentHint: true,
    });

    for (const tool of tools) {
      if (tool.name === "list_todos") {
        // list_todos supports text-only output (`format: "text"`), which the
        // MCP SDK forbids together with a declared output schema. It still
        // returns structured content by default.
        expect(tool.outputSchema).toBeUndefined();
        continue;
      }
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
        todos: Array<{
          hash: string;
          text: string;
          state: number;
          status: string;
        }>;
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
      status: "todo",
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

  it("should support list filters, cursor paging and output formats over MCP", async () => {
    await client.callTool({
      name: "add_todo",
      arguments: {
        todos: [
          "alpha +proj @ctx prio:high",
          "beta +proj @other",
          "gamma +proj @ctx",
        ],
      },
    });

    const filtered = await client.callTool({
      name: "list_todos",
      arguments: {
        context: "@CTX",
        project: "+PROJ",
        sort: "text",
        format: "structured",
      },
    }) as {
      isError?: boolean;
      content: Array<{ type: string; text?: string }>;
      structuredContent?: {
        todos: Array<{ text: string }>;
        total: number;
        nextCursor: string | null;
      };
    };
    expect(filtered.isError).not.toBe(true);
    expect(filtered.content[0].text).toBe("2 todos");
    expect(filtered.structuredContent?.total).toBe(2);
    expect(
      filtered.structuredContent?.todos.map((todo) => todo.text),
    ).toEqual(["alpha +proj @ctx prio:high", "gamma +proj @ctx"]);

    const firstPage = await client.callTool({
      name: "list_todos",
      arguments: { limit: 2 },
    }) as { structuredContent?: { nextCursor: string | null } };
    expect(firstPage.structuredContent?.nextCursor).toEqual(expect.any(String));

    const secondPage = await client.callTool({
      name: "list_todos",
      arguments: {
        limit: 2,
        cursor: firstPage.structuredContent?.nextCursor,
        offset: 99,
      },
    }) as { structuredContent?: { todos: Array<{ text: string }> } };
    expect(secondPage.structuredContent?.todos.map((todo) => todo.text)).toEqual(
      ["gamma +proj @ctx"],
    );

    const textOnly = await client.callTool({
      name: "list_todos",
      arguments: { format: "text" },
    }) as {
      isError?: boolean;
      content: Array<{ type: string; text?: string }>;
      structuredContent?: unknown;
    };
    expect(textOnly.isError).not.toBe(true);
    expect(textOnly.structuredContent).toBeUndefined();
    expect(textOnly.content[0].text).toContain("alpha +proj @ctx");
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

  it("should batch status updates and deletions", async () => {
    const addResult = await client.callTool({
      name: "add_todos",
      arguments: { todos: ["batch one", "batch two", "batch three"] },
    }) as {
      structuredContent?: { added: Array<{ hash: string }> };
    };
    const hashes = addResult.structuredContent!.added.map((todo) => todo.hash);
    const missingHash = "0".repeat(16);

    const statusResult = await client.callTool({
      name: "set_todo_statuses",
      arguments: { hashes: [hashes[0], hashes[1], missingHash], status: "done" },
    }) as {
      structuredContent?: {
        updated: Array<{ hash: string; status: string }>;
        missing: string[];
      };
    };
    expect(statusResult.structuredContent?.updated).toHaveLength(2);
    expect(
      statusResult.structuredContent?.updated.every((todo) =>
        todo.status === "done"
      ),
    ).toBe(true);
    expect(statusResult.structuredContent?.missing).toEqual([missingHash]);

    // Completing a todo changes its hash, so delete using the hash returned by
    // the status call instead of the pre-update hash.
    const completedHash = statusResult.structuredContent!.updated[0].hash;
    const deleteResult = await client.callTool({
      name: "delete_todos",
      arguments: { hashes: [completedHash, missingHash] },
    }) as {
      structuredContent?: {
        deleted: Array<{ hash: string; status: string }>;
        missing: string[];
      };
    };
    expect(deleteResult.structuredContent?.deleted).toHaveLength(1);
    expect(deleteResult.structuredContent?.deleted[0].hash).toBe(
      completedHash,
    );
    expect(deleteResult.structuredContent?.deleted[0].status).toBe("done");
    expect(deleteResult.structuredContent?.missing).toEqual([missingHash]);
    expect(backend.getTodos()).toHaveLength(2);
  });

  it("should delete completed todos by date and context", async () => {
    await client.callTool({
      name: "add_todos",
      arguments: {
        todos: [
          "x 2025-01-01 2024-12-01 old done @Home",
          "x 2026-05-01 2026-04-01 recent done @home",
          "active @home",
        ],
      },
    });

    const result = await client.callTool({
      name: "delete_completed",
      arguments: { before: "2026-01-01", context: "@home" },
    }) as {
      structuredContent?: { deletedCount: number; hashes: string[] };
    };

    expect(result.structuredContent?.deletedCount).toBe(1);
    expect(result.structuredContent?.hashes).toHaveLength(1);
    const remaining = backend.getTodos().map((todo) => todo.text);
    expect(remaining).toHaveLength(2);
    expect(remaining).toContain("recent done @home");
    expect(remaining).toContain("active @home");
  });

  it("should replay an idempotency key over MCP", async () => {
    const first = await client.callTool({
      name: "add_todos",
      arguments: { todos: ["idempotent task"], idempotencyKey: "key-1" },
    }) as {
      structuredContent?: { added: Array<{ hash: string }> };
    };

    const second = await client.callTool({
      name: "add_todos",
      arguments: { todos: ["another task"], idempotencyKey: "key-1" },
    }) as {
      structuredContent?: { added: Array<{ hash: string }> };
    };

    expect(second.structuredContent?.added).toEqual(
      first.structuredContent?.added,
    );
    expect(backend.getTodos()).toHaveLength(1);
    expect(backend.getTodos()[0].text).toBe("idempotent task");
  });

  it("should skip duplicates and fail on duplicates when asked", async () => {
    await client.callTool({
      name: "add_todos",
      arguments: { todos: ["dup task"] },
    });

    const skipped = await client.callTool({
      name: "add_todos",
      arguments: { todos: ["  DUP   task"], onDuplicate: "skip" },
    }) as {
      structuredContent?: {
        added: unknown[];
        skipped: Array<{ text: string; hash: string }>;
      };
    };
    expect(skipped.structuredContent?.added).toEqual([]);
    expect(skipped.structuredContent?.skipped).toHaveLength(1);
    expect(backend.getTodos()).toHaveLength(1);

    const errored = await client.callTool({
      name: "add_todos",
      arguments: { todos: ["dup task"], onDuplicate: "error" },
    }) as { isError?: boolean };
    expect(errored.isError).toBe(true);
    expect(backend.getTodos()).toHaveLength(1);
  });

  it("should only expose list_todos in read-only mode", async () => {
    const readOnlyServer = createTodoMcpServer(backend, { readOnly: true });
    const [clientTransport, serverTransport] = InMemoryTransport
      .createLinkedPair();
    const readOnlyClient = new Client({
      name: "todo-txt-mcp-read-only-test",
      version: "1.0.0",
    });

    try {
      await Promise.all([
        readOnlyClient.connect(clientTransport),
        readOnlyServer.connect(serverTransport),
      ]);

      const { tools } = await readOnlyClient.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["list_todos"]);
    } finally {
      await Promise.allSettled([
        readOnlyClient.close(),
        readOnlyServer.close(),
      ]);
    }
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
