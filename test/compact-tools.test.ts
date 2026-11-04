import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTodoMcpServer } from "../server.ts";
import { MockBackend } from "./helpers/mock-backend.ts";
import { Todo } from "../logic/todo.ts";

interface ToolTextResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
}

function textOf(result: unknown): string {
  const { content } = result as ToolTextResult;
  return content.map((item) => item.text ?? "").join("\n");
}

function hashOf(result: unknown): string {
  const match = textOf(result).match(/^\[?([0-9a-f]{16})\]?/);
  if (!match) {
    throw new Error(`No hash in: ${textOf(result)}`);
  }
  return match[1];
}

function errorCodeOf(result: unknown): string | undefined {
  return (result as ToolTextResult & {
    structuredContent?: { error?: { code?: string } };
  }).structuredContent?.error?.code;
}

describe("compact toolset", () => {
  let backend: MockBackend;
  let client: Client;
  let server: ReturnType<typeof createTodoMcpServer>;

  beforeEach(async () => {
    backend = new MockBackend();
    server = createTodoMcpServer(backend, { toolset: "compact" });
    const [clientTransport, serverTransport] = InMemoryTransport
      .createLinkedPair();
    client = new Client({
      name: "todo-txt-mcp-compact-test-client",
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

  it("exposes exactly the four compact tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "add_todo",
      "edit_todo",
      "list_todos",
      "mark_done",
    ]);
  });

  it("adds one todo and returns only its hash", async () => {
    const result = await client.callTool({
      name: "add_todo",
      arguments: { text: "Buy milk @home" },
    });

    expect(textOf(result)).toMatch(/^[0-9a-f]{16}$/);
    expect(result.structuredContent).toBeUndefined();
    expect(backend.getTodos()).toHaveLength(1);
    expect(backend.getTodos()[0].text).toBe("Buy milk @home");
  });

  it("changes priority and replaces a context in one call", async () => {
    const todos = [new Todo("(C) 2025-01-02 Report @work +finance")];
    await backend.save(todos);
    const originalHash = await todos[0].getHash();

    const result = await client.callTool({
      name: "edit_todo",
      arguments: {
        hash: originalHash,
        priority: "A",
        removeContexts: ["work"],
        addContexts: ["office"],
      },
    });

    const newHash = hashOf(result);
    expect(newHash).not.toBe(originalHash);
    const target = backend.getTodos()[0];
    expect(target.priority).toBe("A");
    expect(target.contexts.has("office")).toBe(true);
    expect(target.contexts.has("work")).toBe(false);
    expect(target.toString()).toContain("+finance @office");
  });

  it("accepts a leading @ on context names and ignores duplicates", async () => {
    const todos = [new Todo("Report @office")];
    await backend.save(todos);
    const hash = await todos[0].getHash();

    await client.callTool({
      name: "edit_todo",
      arguments: {
        hash,
        addContexts: ["@Office", "office"],
      },
    });

    expect(backend.getTodos()[0].contexts.size).toBe(1);
    expect(backend.getTodos()[0].toString().match(/@office/gi)).toHaveLength(1);
  });

  it("edits body text and clears priority with null", async () => {
    const todos = [new Todo("(B) [ ] Old text @home")];
    await backend.save(todos);
    const hash = await todos[0].getHash();

    await client.callTool({
      name: "edit_todo",
      arguments: { hash, text: "New text @home", priority: null },
    });

    const target = backend.getTodos()[0];
    expect(target.text).toBe("New text @home");
    expect(target.priority).toBeUndefined();
    expect(target.toString()).toBe("New text @home");
  });

  it("marks a todo done once and is idempotent", async () => {
    const todos = [new Todo("Ship it @work")];
    await backend.save(todos);
    const hash = await todos[0].getHash();
    backend.saveCalls = 0;

    const first = await client.callTool({
      name: "mark_done",
      arguments: { hash },
    });
    expect(backend.getTodos()[0].isDone()).toBe(true);
    expect(backend.saveCalls).toBe(1);

    const doneHash = hashOf(first);
    const second = await client.callTool({
      name: "mark_done",
      arguments: { hash: doneHash },
    });
    expect(backend.saveCalls).toBe(1);
    expect(hashOf(second)).toBe(doneHash);
    expect(backend.getTodos()[0].isDone()).toBe(true);
  });

  it("returns a compact list without structured content", async () => {
    await backend.save([
      new Todo("First @home"),
      new Todo("Second @work"),
    ]);

    const result = await client.callTool({
      name: "list_todos",
      arguments: { context: "home" },
    });

    expect(textOf(result)).toMatch(/^[0-9a-f]{16} First @home$/);
    expect(result.structuredContent).toBeUndefined();
  });

  it("rejects an edit with no changes", async () => {
    const todos = [new Todo("Keep me")];
    await backend.save(todos);
    const hash = await todos[0].getHash();

    const result = await client.callTool({
      name: "edit_todo",
      arguments: { hash },
    });

    expect(result.isError).toBe(true);
    expect(errorCodeOf(result)).toBe("INVALID_ARGUMENT");
  });

  it("reports an unknown hash without writing", async () => {
    const result = await client.callTool({
      name: "edit_todo",
      arguments: { hash: "0123456789abcdef", priority: "A" },
    });

    expect(result.isError).toBe(true);
    expect(errorCodeOf(result)).toBe("TODO_NOT_FOUND");
    expect(backend.saveCalls).toBe(0);
  });

  it("exposes only list_todos in compact read-only mode", async () => {
    const readOnlyServer = createTodoMcpServer(backend, {
      toolset: "compact",
      readOnly: true,
    });
    const [clientTransport, serverTransport] = InMemoryTransport
      .createLinkedPair();
    const readOnlyClient = new Client({
      name: "todo-txt-mcp-compact-readonly-test-client",
      version: "1.0.0",
    });
    await Promise.all([
      readOnlyClient.connect(clientTransport),
      readOnlyServer.connect(serverTransport),
    ]);

    try {
      const { tools } = await readOnlyClient.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["list_todos"]);
    } finally {
      await Promise.allSettled([
        readOnlyClient.close(),
        readOnlyServer.close(),
      ]);
    }
  });
});
