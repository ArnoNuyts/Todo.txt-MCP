import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTodoMcpServer } from "../server.ts";
import { MockBackend } from "./helpers/mock-backend.ts";
import { Todo } from "../logic/todo.ts";
import { computeContentVersion } from "../logic/content.ts";

interface ToolTextResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
}

function textOf(result: unknown): string {
  const { content } = result as ToolTextResult;
  return content.map((item) => item.text ?? "").join("\n");
}

function linesOf(result: unknown): string[] {
  return textOf(result).split("\n");
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

  it("exposes the four batch tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "add_todos",
      "list_todos",
      "mark_done",
      "update_todos",
    ]);
  });

  it("adds multiple todos in one call and returns their hashes", async () => {
    const result = await client.callTool({
      name: "add_todos",
      arguments: {
        todos: ["Buy milk @home", "(A) Renew passport @errands"],
      },
    });

    const lines = linesOf(result);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^[0-9a-f]{16} Buy milk @home$/);
    expect(lines[1]).toMatch(/^[0-9a-f]{16} \(A\) Renew passport @errands$/);
    expect(result.structuredContent).toBeUndefined();
    expect(backend.getTodos()).toHaveLength(2);
  });

  it("updates priority and contexts for multiple todos in one save", async () => {
    const todos = [
      new Todo("(C) 2025-01-02 Report @work +finance due:2026-12-15"),
      new Todo("(D) 2025-01-02 Budget @work +finance"),
    ];
    await backend.save(todos);
    const reportHash = await todos[0].getHash();
    const budgetHash = await todos[1].getHash();
    backend.loadCalls = 0;
    backend.saveCalls = 0;

    const result = await client.callTool({
      name: "update_todos",
      arguments: {
        edits: [
          {
            hash: reportHash,
            priority: "A",
            removeContexts: ["work"],
            addContexts: ["office"],
          },
          {
            hash: budgetHash,
            priority: "A",
            removeContexts: ["work"],
            addContexts: ["office"],
          },
        ],
      },
    });

    expect(linesOf(result)).toHaveLength(2);
    expect(backend.loadCalls).toBe(1);
    expect(backend.saveCalls).toBe(1);
    expect(backend.getTodos()[0].priority).toBe("A");
    expect(backend.getTodos()[0].toString()).toContain("+finance @office");
    expect(backend.getTodos()[0].tags.due).toBe("2026-12-15");
    expect(backend.getTodos()[1].priority).toBe("A");
    expect(backend.getTodos()[1].contexts.has("work")).toBe(false);
  });

  it("rejects duplicate hashes and edits with no changes", async () => {
    const todos = [new Todo("Keep me @home")];
    await backend.save(todos);
    const hash = await todos[0].getHash();

    const duplicate = await client.callTool({
      name: "update_todos",
      arguments: {
        edits: [{ hash, priority: "A" }, { hash, priority: "B" }],
      },
    });
    expect(duplicate.isError).toBe(true);
    expect(errorCodeOf(duplicate)).toBe("INVALID_ARGUMENT");

    const empty = await client.callTool({
      name: "update_todos",
      arguments: { edits: [{ hash }] },
    });
    expect(empty.isError).toBe(true);
    expect(errorCodeOf(empty)).toBe("INVALID_ARGUMENT");
  });

  it("marks multiple todos done in one save and is idempotent", async () => {
    const todos = [
      new Todo("Ship it @work"),
      new Todo("Buy milk @home"),
    ];
    await backend.save(todos);
    const hashes = await Promise.all(todos.map((todo) => todo.getHash()));
    backend.loadCalls = 0;
    backend.saveCalls = 0;

    const first = await client.callTool({
      name: "mark_done",
      arguments: { hashes },
    });
    expect(linesOf(first)).toHaveLength(2);
    expect(backend.loadCalls).toBe(1);
    expect(backend.saveCalls).toBe(1);
    expect(backend.getTodos().every((todo) => todo.isDone())).toBe(true);

    const doneHashes = linesOf(first).map((line) => line.slice(0, 16));
    const second = await client.callTool({
      name: "mark_done",
      arguments: { hashes: doneHashes },
    });
    expect(linesOf(second)).toHaveLength(2);
    expect(backend.saveCalls).toBe(1);
  });

  it("returns a partial batch result for a missing hash", async () => {
    const todos = [new Todo("Keep me")];
    await backend.save(todos);
    const hash = await todos[0].getHash();

    const result = await client.callTool({
      name: "mark_done",
      arguments: { hashes: [hash, "0123456789abcdef"] },
    });

    expect(textOf(result)).toContain("ERROR 0123456789abcdef not found");
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

describe("compact-plus toolset", () => {
  let backend: MockBackend;
  let client: Client;
  let server: ReturnType<typeof createTodoMcpServer>;

  beforeEach(async () => {
    backend = new MockBackend();
    server = createTodoMcpServer(backend, { toolset: "compact-plus" });
    const [clientTransport, serverTransport] = InMemoryTransport
      .createLinkedPair();
    client = new Client({
      name: "todo-txt-mcp-compact-plus-test-client",
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

  it("adds only changes_since to the compact surface", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "add_todos",
      "changes_since",
      "list_todos",
      "mark_done",
      "update_todos",
    ]);
  });

  it("reports changes and unchanged versions as terse text", async () => {
    const todos = [new Todo("Buy milk @home")];
    await backend.save(todos);
    const current = computeContentVersion(todos);

    const changed = await client.callTool({
      name: "changes_since",
      arguments: { version: "stale-version" },
    });
    expect(textOf(changed)).toContain("changed");
    expect(textOf(changed)).toContain("Buy milk @home");
    expect(changed.structuredContent).toBeUndefined();

    const same = await client.callTool({
      name: "changes_since",
      arguments: { version: current },
    });
    expect(textOf(same)).toContain("No changes since version");
    expect(same.structuredContent).toBeUndefined();
  });
});
