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
  return (result as ToolTextResult).content
    .map((item) => item.text ?? "")
    .join("\n");
}

function linesOf(result: unknown): string[] {
  return textOf(result).split("\n");
}

function hashesOf(result: unknown): string[] {
  return linesOf(result).map((line) => line.split(" ")[0]);
}

function errorCodeOf(result: unknown): string | undefined {
  return (result as ToolTextResult & {
    structuredContent?: { error?: { code?: string } };
  }).structuredContent?.error?.code;
}

describe("tool surface", () => {
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

  it("exposes only the four tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "add_todos",
      "delete_todos",
      "list_todos",
      "set_todo_statuses",
      "update_todos",
    ]);
    for (const tool of tools) {
      expect(tool.outputSchema).toBeUndefined();
    }
  });

  it("adds a batch and returns text-only hash lines", async () => {
    const result = await client.callTool({
      name: "add_todos",
      arguments: {
        todos: ["Buy milk @home", "(A) Renew passport @errands"],
      },
    });

    expect(result.structuredContent).toBeUndefined();
    const lines = linesOf(result);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^[A-Za-z0-9_-]{11} Buy milk @home$/);
    expect(lines[1]).toMatch(
      /^[A-Za-z0-9_-]{11} \(A\) Renew passport @errands$/,
    );
    expect(backend.getTodos()).toHaveLength(2);
  });

  it("lists with search, status, context and limit", async () => {
    await backend.save([
      new Todo("Buy milk @home"),
      new Todo("Write report @work"),
      new Todo("x Done task @home"),
    ]);

    const active = await client.callTool({
      name: "list_todos",
      arguments: {},
    });
    expect(textOf(active)).toContain("Buy milk");
    expect(textOf(active)).toContain("Write report");
    expect(textOf(active)).not.toContain("Done task");

    const done = await client.callTool({
      name: "list_todos",
      arguments: { status: "done" },
    });
    expect(textOf(done)).toContain("Done task");

    const home = await client.callTool({
      name: "list_todos",
      arguments: { context: "home" },
    });
    expect(textOf(home)).toContain("Buy milk");
    expect(textOf(home)).not.toContain("Write report");

    const limited = await client.callTool({
      name: "list_todos",
      arguments: { limit: 1 },
    });
    expect(linesOf(limited)).toHaveLength(1);
  });

  it("updates priority and contexts for multiple todos in one save", async () => {
    const todos = [
      new Todo("(C) 2025-01-02 Report @work +finance due:2026-12-15"),
      new Todo("(D) 2025-01-02 Budget @work +finance"),
    ];
    await backend.save(todos);
    const hashes = await Promise.all(todos.map((todo) => todo.getHash()));
    backend.loadCalls = 0;
    backend.saveCalls = 0;

    const result = await client.callTool({
      name: "update_todos",
      arguments: {
        edits: hashes.map((hash) => ({
          hash,
          priority: "A",
          removeContexts: ["work"],
          addContexts: ["office"],
        })),
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
    const todo = new Todo("Keep me @home");
    await backend.save([todo]);
    const hash = await todo.getHash();

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

  it("marks multiple todos done and is idempotent", async () => {
    const todos = [new Todo("Ship it @work"), new Todo("Buy milk @home")];
    await backend.save(todos);
    const hashes = await Promise.all(todos.map((todo) => todo.getHash()));
    backend.loadCalls = 0;
    backend.saveCalls = 0;

    const first = await client.callTool({
      name: "set_todo_statuses",
      arguments: { hashes, status: "done" },
    });
    expect(linesOf(first)).toHaveLength(2);
    expect(backend.loadCalls).toBe(1);
    expect(backend.saveCalls).toBe(1);
    expect(backend.getTodos().every((todo) => todo.isDone())).toBe(true);

    const doneHashes = hashesOf(first);
    const second = await client.callTool({
      name: "set_todo_statuses",
      arguments: { hashes: doneHashes, status: "done" },
    });
    expect(linesOf(second)).toHaveLength(2);
    expect(backend.saveCalls).toBe(1);
  });

  it("returns a partial result for a missing hash", async () => {
    const todo = new Todo("Keep me");
    await backend.save([todo]);
    const hash = await todo.getHash();

    const result = await client.callTool({
      name: "set_todo_statuses",
      arguments: { hashes: [hash, "0123456789abcdef"], status: "done" },
    });

    expect(textOf(result)).toContain("ERROR 0123456789abcdef not found");
    expect(backend.getTodos()[0].isDone()).toBe(true);
  });

  it("reopens completed todos in one batch", async () => {
    const todos = [
      new Todo("x 2026-01-01 2025-01-01 First done"),
      new Todo("x 2026-01-01 2025-01-01 Second done"),
      new Todo("Still open"),
    ];
    await backend.save(todos);
    const hashes = await Promise.all(todos.slice(0, 2).map((t) => t.getHash()));
    backend.saveCalls = 0;

    const result = await client.callTool({
      name: "set_todo_statuses",
      arguments: { hashes, status: "todo" },
    });

    expect(linesOf(result)).toHaveLength(2);
    expect(backend.saveCalls).toBe(1);
    expect(backend.getTodos()[0].isDone()).toBe(false);
    expect(backend.getTodos()[1].isDone()).toBe(false);
    expect(backend.getTodos()[2].isDone()).toBe(false);
  });

  it("deletes multiple todos in one batch", async () => {
    const todos = [
      new Todo("Delete one"),
      new Todo("Delete two"),
      new Todo("Keep me"),
    ];
    await backend.save(todos);
    const hashes = await Promise.all(todos.slice(0, 2).map((t) => t.getHash()));
    backend.saveCalls = 0;

    const result = await client.callTool({
      name: "delete_todos",
      arguments: { hashes },
    });

    expect(linesOf(result)).toHaveLength(2);
    expect(backend.saveCalls).toBe(1);
    expect(backend.getTodos().map((todo) => todo.text)).toEqual(["Keep me"]);

    const missing = await client.callTool({
      name: "delete_todos",
      arguments: { hashes: ["0123456789abcdef"] },
    });
    expect(textOf(missing)).toContain("not found");
  });
});
