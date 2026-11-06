import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTodoMcpServer } from "../server.ts";
import { MockBackend } from "./helpers/mock-backend.ts";

/** Shape of the text-only tool results this server returns. */
interface ToolTextResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
}

function textOf(result: unknown): string {
  const { content } = result as ToolTextResult;
  return content.map((item) => item.text ?? "").join("\n");
}

function hashesOf(result: unknown): string[] {
  return [...textOf(result).matchAll(/\[([A-Za-z0-9_-]{11})\]/g)]
    .map((match) => match[1]);
}

function firstHash(result: unknown): string {
  const hash = hashesOf(result)[0];
  if (hash === undefined) {
    throw new Error(`No hash in: ${textOf(result)}`);
  }
  return hash;
}

function errorCodeOf(result: unknown): string | undefined {
  return (result as ToolTextResult & {
    structuredContent?: { error?: { code?: string } };
  }).structuredContent?.error?.code;
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

  it("exposes the canonical tools only", async () => {
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "add_todos",
      "changes_since",
      "delete_todos",
      "export_todos",
      "import_todos",
      "list_todos",
      "set_todo_statuses",
      "summary",
      "update_todos",
    ]);
    for (const tool of tools) {
      expect(tool.outputSchema, `${tool.name} output schema`).toBeUndefined();
    }
  });

  it("exposes annotations for the mutating tools", async () => {
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
  });

  it("returns text-only results with no structured payload", async () => {
    const added = await client.callTool({
      name: "add_todos",
      arguments: { todos: ["text todo"] },
    });
    expect(added.structuredContent).toBeUndefined();
    const hash = firstHash(added);
    expect(hash).toMatch(/^[A-Za-z0-9_-]{11}$/);

    const listed = await client.callTool({
      name: "list_todos",
      arguments: {},
    });
    expect(listed.structuredContent).toBeUndefined();
    expect(textOf(listed)).toBe(`[${hash}] text todo`);

    const edited = await client.callTool({
      name: "update_todos",
      arguments: {
        edits: [{ hash, text: "text todo edited" }],
      },
    });
    expect(edited.structuredContent).toBeUndefined();
    const editedHash = firstHash(edited);
    expect(textOf(edited)).toContain("text todo edited");

    const done = await client.callTool({
      name: "set_todo_statuses",
      arguments: { hashes: [editedHash], status: "done" },
    });
    expect(done.structuredContent).toBeUndefined();
    expect(textOf(done)).toContain("status to done");
    expect(backend.getTodos()[0].isDone()).toBe(true);
  });

  it("supports filters and cursor paging over text results", async () => {
    await client.callTool({
      name: "add_todos",
      arguments: {
        todos: [
          "alpha +proj @ctx",
          "beta +proj @other",
          "gamma +proj @ctx",
        ],
      },
    });

    const filtered = await client.callTool({
      name: "list_todos",
      arguments: { context: "@CTX", project: "+PROJ", sort: "text" },
    });
    const filteredText = textOf(filtered);
    expect(filteredText).toContain("alpha +proj @ctx");
    expect(filteredText).toContain("gamma +proj @ctx");
    expect(filteredText).not.toContain("beta +proj @other");

    const firstPage = await client.callTool({
      name: "list_todos",
      arguments: { limit: 2 },
    });
    const next = textOf(firstPage).match(/^NEXT (.+)$/m)?.[1];
    expect(next).toBeDefined();

    const secondPage = await client.callTool({
      name: "list_todos",
      arguments: { limit: 2, cursor: next, offset: 99 },
    });
    expect(textOf(secondPage)).toContain("gamma +proj @ctx");
  });

  it("deletes a todo by hash and reports missing hashes", async () => {
    const addResult = await client.callTool({
      name: "add_todos",
      arguments: { todos: ["delete me"] },
    });
    const hash = firstHash(addResult);

    const deleteResult = await client.callTool({
      name: "delete_todos",
      arguments: { hashes: [hash] },
    });
    expect(deleteResult.structuredContent).toBeUndefined();
    expect(textOf(deleteResult)).toContain("delete me");
    expect(backend.getTodos()).toHaveLength(0);

    const missingResult = await client.callTool({
      name: "delete_todos",
      arguments: { hashes: [hash] },
    });
    expect(textOf(missingResult)).toBe(`Todo with hash ${hash} not found.`);
  });

  it("batches status updates and deletions", async () => {
    const addResult = await client.callTool({
      name: "add_todos",
      arguments: { todos: ["batch one", "batch two", "batch three"] },
    });
    const hashes = hashesOf(addResult);
    const missingHash = "0".repeat(11);

    const statusResult = await client.callTool({
      name: "set_todo_statuses",
      arguments: {
        hashes: [hashes[0], hashes[1], missingHash],
        status: "done",
      },
    });
    const statusText = textOf(statusResult);
    expect(statusText).toContain("batch one");
    expect(statusText).toContain("batch two");
    expect(statusText).toContain(
      `Todo with hash ${missingHash} not found.`,
    );

    const completedHashes = hashesOf(statusResult);
    expect(completedHashes).toHaveLength(2);
    const deleteResult = await client.callTool({
      name: "delete_todos",
      arguments: { hashes: [completedHashes[0], missingHash] },
    });
    expect(textOf(deleteResult)).toContain(
      `Todo with hash ${missingHash} not found.`,
    );
    expect(backend.getTodos()).toHaveLength(2);
  });

  it("replays an idempotency key over MCP", async () => {
    const first = await client.callTool({
      name: "add_todos",
      arguments: { todos: ["idempotent task"], idempotencyKey: "key-1" },
    });
    const firstHashValue = firstHash(first);

    const second = await client.callTool({
      name: "add_todos",
      arguments: { todos: ["another task"], idempotencyKey: "key-1" },
    });

    expect(firstHash(second)).toBe(firstHashValue);
    expect(backend.getTodos()).toHaveLength(1);
    expect(backend.getTodos()[0].text).toBe("idempotent task");
  });

  it("skips duplicates and fails on duplicates when asked", async () => {
    await client.callTool({
      name: "add_todos",
      arguments: { todos: ["dup task"] },
    });

    const skipped = await client.callTool({
      name: "add_todos",
      arguments: { todos: ["  DUP   task"], onDuplicate: "skip" },
    });
    expect(textOf(skipped)).toContain("Skipped duplicate todo");
    expect(backend.getTodos()).toHaveLength(1);

    const errored = await client.callTool({
      name: "add_todos",
      arguments: { todos: ["dup task"], onDuplicate: "error" },
    });
    expect(errored.isError).toBe(true);
    expect(errorCodeOf(errored)).toBe("CONFLICT");
    expect(backend.getTodos()).toHaveLength(1);
  });

  it("only exposes list_todos in read-only mode", async () => {
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

  it("exposes a todo_format prompt with a user message", async () => {
    const result = await client.getPrompt({ name: "todo_format" });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content).toMatchObject({ type: "text" });
    const content = result.messages[0].content as { text: string };
    expect(content.text).toContain("todo.txt");
  });

  it("supports an add -> list -> edit -> set_todo_status flow", async () => {
    const addResult = await client.callTool({
      name: "add_todos",
      arguments: { todos: ["write tests"] },
    });
    const addedHash = firstHash(addResult);
    expect(textOf(addResult)).toContain("write tests");

    const listResult = await client.callTool({
      name: "list_todos",
      arguments: {},
    });
    expect(textOf(listResult)).toContain(addedHash);
    expect(textOf(listResult)).toContain("write tests");

    const editResult = await client.callTool({
      name: "update_todos",
      arguments: {
        edits: [{ hash: addedHash, text: "write more tests" }],
      },
    });
    expect(textOf(editResult)).toContain("write more tests");
    const editedHash = firstHash(editResult);

    const statusResult = await client.callTool({
      name: "set_todo_statuses",
      arguments: { hashes: [editedHash], status: "done" },
    });
    expect(statusResult.isError).not.toBe(true);
    expect(textOf(statusResult)).toContain("status to done");

    const storedTodos = backend.getTodos();
    expect(storedTodos.length).toBe(1);
    expect(storedTodos[0].isDone()).toBe(true);
    expect(storedTodos[0].text).toBe("write more tests");

    const doneList = await client.callTool({
      name: "list_todos",
      arguments: { status: "done" },
    });
    expect(textOf(doneList)).toContain("write more tests");
  });

  it("reports tool errors with a stable code", async () => {
    await client.callTool({
      name: "add_todos",
      arguments: { todos: ["duplicate"] },
    });
    const result = await client.callTool({
      name: "add_todos",
      arguments: { todos: ["duplicate"], onDuplicate: "error" },
    });
    expect(result.isError).toBe(true);
    expect(errorCodeOf(result)).toBe("CONFLICT");
  });
});
