import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTodoMcpServer } from "../server.ts";
import { Todo } from "../logic/todo.ts";
import { MockBackend } from "./helpers/mock-backend.ts";

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

function errorCodeOf(result: unknown): string | undefined {
  return (result as ToolTextResult & {
    structuredContent?: { error?: { code?: string } };
  }).structuredContent?.error?.code;
}

async function hashOf(todo: Todo): Promise<string> {
  return await todo.getHash();
}

describe("text-only update_todos", () => {
  let backend: MockBackend;
  let client: Client;
  let server: ReturnType<typeof createTodoMcpServer>;

  beforeEach(async () => {
    backend = new MockBackend();
    server = createTodoMcpServer(backend);
    const [clientTransport, serverTransport] = InMemoryTransport
      .createLinkedPair();
    client = new Client({
      name: "todo-txt-mcp-text-update-test-client",
      version: "1.0.0",
    });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.allSettled([client.close(), server.close()]);
  });

  it("preserves the creation date when the new line omits it", async () => {
    const todo = new Todo("2025-01-02 Task @work");
    await backend.save([todo]);
    const hash = await hashOf(todo);

    const result = await client.callTool({
      name: "update_todos",
      arguments: { updates: [`${hash} (A) Task @office`] },
    });

    expect(result.isError).toBeFalsy();
    const updated = backend.getTodos()[0];
    expect(updated.creationDate?.toISOString().slice(0, 10)).toBe("2025-01-02");
    expect(updated.priority).toBe("A");
    expect(updated.contexts.has("office")).toBe(true);
    expect(updated.contexts.has("work")).toBe(false);
  });

  it("uses an explicit creation date when the new line includes one", async () => {
    const todo = new Todo("2025-01-02 Task");
    await backend.save([todo]);
    const hash = await hashOf(todo);

    await client.callTool({
      name: "update_todos",
      arguments: { updates: [`${hash} 2026-03-04 Task`] },
    });

    expect(backend.getTodos()[0].creationDate?.toISOString().slice(0, 10))
      .toBe("2026-03-04");
  });

  it("completes now when the new line starts with x and no date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-06-15T12:00:00.000Z"));
    const todo = new Todo("Task");
    await backend.save([todo]);
    const hash = await hashOf(todo);

    await client.callTool({
      name: "update_todos",
      arguments: { updates: [`${hash} x Task`] },
    });

    const updated = backend.getTodos()[0];
    expect(updated.isDone()).toBe(true);
    expect(updated.completionDate?.toISOString().slice(0, 10)).toBe("2024-06-15");
  });

  it("uses an explicit completion date and spawns recurrence from it", async () => {
    const todo = new Todo("Task due:2024-06-20 rec:+1w");
    await backend.save([todo]);
    const hash = await hashOf(todo);

    await client.callTool({
      name: "update_todos",
      arguments: {
        updates: [`${hash} x 2024-06-10 Task due:2024-06-20 rec:1w`],
      },
    });

    const completed = backend.getTodos().find((item) => item.isDone());
    const next = backend.getTodos().find((item) => !item.isDone());
    expect(completed?.completionDate?.toISOString().slice(0, 10))
      .toBe("2024-06-10");
    expect(next?.tags.due).toBe("2024-06-17");
  });

  it("reopens a completed todo and clears its completion date", async () => {
    const todo = new Todo("x 2026-01-01 Task");
    await backend.save([todo]);
    const hash = await hashOf(todo);

    await client.callTool({
      name: "update_todos",
      arguments: { updates: [`${hash} Task`] },
    });

    const updated = backend.getTodos()[0];
    expect(updated.isDone()).toBe(false);
    expect(updated.completionDate).toBeUndefined();
  });

  it("replaces omitted fields instead of merging them", async () => {
    const todo = new Todo("(A) Task @home due:2026-01-01");
    await backend.save([todo]);
    const hash = await hashOf(todo);

    await client.callTool({
      name: "update_todos",
      arguments: { updates: [`${hash} Task`] },
    });

    const updated = backend.getTodos()[0];
    expect(updated.priority).toBeUndefined();
    expect(updated.contexts.size).toBe(0);
    expect(updated.tags.due).toBeUndefined();
  });

  it("returns a partial result for a missing hash", async () => {
    const todo = new Todo("Keep me");
    await backend.save([todo]);
    const hash = await hashOf(todo);

    const result = await client.callTool({
      name: "update_todos",
      arguments: {
        updates: [
          `${hash} x Keep me`,
          "0123456789abcdef x Missing",
        ],
      },
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("PARTIAL 1 updated, 1 not found");
    expect(textOf(result)).toContain("ERROR 0123456789abcdef not found");
    expect(backend.getTodos()[0].isDone()).toBe(true);
  });

  it("rejects duplicate hashes in one batch", async () => {
    const todo = new Todo("Task");
    await backend.save([todo]);
    const hash = await hashOf(todo);
    backend.saveCalls = 0;

    const result = await client.callTool({
      name: "update_todos",
      arguments: {
        updates: [`${hash} (A) Task`, `${hash} (B) Task`],
      },
    });

    expect(result.isError).toBe(true);
    expect(errorCodeOf(result)).toBe("INVALID_ARGUMENT");
    expect(backend.saveCalls).toBe(0);
  });

  it("rejects a malformed update line", async () => {
    const result = await client.callTool({
      name: "update_todos",
      arguments: { updates: ["not-a-hash"] },
    });

    expect(result.isError).toBe(true);
    expect(errorCodeOf(result)).toBe("INVALID_ARGUMENT");
    expect(textOf(result)).toContain("<hash> <text>");
  });

  it("rejects an ambiguous hash shared by identical lines", async () => {
    const todos = [new Todo("Dup"), new Todo("Dup")];
    await backend.save(todos);
    const hash = await hashOf(todos[0]);

    const result = await client.callTool({
      name: "update_todos",
      arguments: { updates: [`${hash} (A) Dup`] },
    });

    expect(result.isError).toBe(true);
    expect(errorCodeOf(result)).toBe("CONFLICT");
  });
});
