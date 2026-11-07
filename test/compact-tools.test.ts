import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    expect(linesOf(limited)).toHaveLength(2);
    expect(textOf(limited)).toContain("MORE 1 (offset=1)");

    const offset = await client.callTool({
      name: "list_todos",
      arguments: { limit: 1, offset: 1 },
    });
    expect(linesOf(offset)).toHaveLength(1);
    expect(textOf(offset)).toContain("Write report");
  });

  it("omits hidden and future-threshold todos from list_todos", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T12:00:00.000Z"));
    try {
      await backend.save([
        new Todo("Visible task @home"),
        new Todo("Hidden task @home h:1"),
        new Todo("Future task @home t:2027-05-01"),
      ]);

      const active = await client.callTool({
        name: "list_todos",
        arguments: {},
      });
      expect(textOf(active)).toContain("Visible task");
      expect(textOf(active)).not.toContain("Hidden task");
      expect(textOf(active)).not.toContain("Future task");

      const all = await client.callTool({
        name: "list_todos",
        arguments: { status: "all" },
      });
      expect(textOf(all)).toContain("Visible task");
      expect(textOf(all)).toContain("Hidden task");
      expect(textOf(all)).toContain("Future task");
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts only visible todos when paginating", async () => {
    await backend.save([
      new Todo("Hidden one h:1"),
      new Todo("Hidden two h:1"),
      new Todo("Visible one"),
      new Todo("Visible two"),
    ]);

    const first = await client.callTool({
      name: "list_todos",
      arguments: { limit: 1 },
    });
    expect(textOf(first)).toContain("Visible one");
    expect(textOf(first)).not.toContain("Hidden");
    expect(textOf(first)).toContain("MORE 1 (offset=1)");

    const second = await client.callTool({
      name: "list_todos",
      arguments: { limit: 1, offset: 1 },
    });
    expect(textOf(second)).toContain("Visible two");
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
        updates: [
          `${hashes[0]} (A) Report @office +finance due:2026-12-15`,
          `${hashes[1]} (A) Budget @office +finance`,
        ],
      },
    });

    expect(linesOf(result)).toHaveLength(2);
    expect(backend.loadCalls).toBe(1);
    expect(backend.saveCalls).toBe(1);
    expect(backend.getTodos()[0].priority).toBe("A");
    expect(backend.getTodos()[0].contexts.has("office")).toBe(true);
    expect(backend.getTodos()[0].projects.has("finance")).toBe(true);
    expect(backend.getTodos()[0].tags.due).toBe("2026-12-15");
    expect(backend.getTodos()[0].creationDate?.toISOString().slice(0, 10))
      .toBe("2025-01-02");
    expect(backend.getTodos()[1].priority).toBe("A");
    expect(backend.getTodos()[1].contexts.has("work")).toBe(false);
  });

  it("sets and clears threshold and recurrence tags", async () => {
    const todos = [new Todo("Water plants @home"), new Todo("Feed cat @home")];
    await backend.save(todos);
    const hashes = await Promise.all(todos.map((todo) => todo.getHash()));
    backend.saveCalls = 0;

    const updated = await client.callTool({
      name: "update_todos",
      arguments: {
        updates: [
          `${hashes[0]} Water plants @home t:2026-12-01 rec:+2w`,
          `${hashes[1]} Feed cat @home t:2026-12-01 rec:+2w`,
        ],
      },
    });

    expect(linesOf(updated)).toHaveLength(2);
    expect(backend.saveCalls).toBe(1);
    expect(backend.getTodos()[0].tags.t).toBe("2026-12-01");
    expect(backend.getTodos()[0].tags.rec).toBe("+2w");
    expect(backend.getTodos()[1].tags.t).toBe("2026-12-01");

    const newHash = await backend.getTodos()[0].getHash();
    await client.callTool({
      name: "update_todos",
      arguments: { updates: [`${newHash} Water plants @home`] },
    });

    expect(backend.saveCalls).toBe(2);
    expect(backend.getTodos()[0].tags.t).toBeUndefined();
    expect(backend.getTodos()[0].tags.rec).toBeUndefined();
    expect(backend.getTodos()[1].tags.rec).toBe("+2w");
  });

  it("applies tags before status so the recurrence inherits them", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-06-15T12:00:00.000Z"));
    try {
      const todo = new Todo("Water plants due:2024-06-20 rec:1w");
      await backend.save([todo]);
      const hash = await todo.getHash();

      await client.callTool({
        name: "update_todos",
        arguments: {
          updates: [
            `${hash} x Water plants due:2024-06-20 t:2024-06-10 rec:+1w`,
          ],
        },
      });

      const todos = backend.getTodos();
      const completed = todos.find((item) => item.isDone());
      const next = todos.find((item) => !item.isDone());

      expect(completed?.tags.t).toBe("2024-06-10");
      expect(completed?.tags.rec).toBe("+1w");
      expect(next?.tags.t).toBe("2024-06-17");
      expect(next?.tags.rec).toBe("+1w");
      expect(next?.tags.due).toBe("2024-06-27");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects duplicate hashes in one update batch", async () => {
    const todo = new Todo("Keep me @home");
    await backend.save([todo]);
    const hash = await todo.getHash();

    const duplicate = await client.callTool({
      name: "update_todos",
      arguments: {
        updates: [`${hash} (A) Keep me @home`, `${hash} (B) Keep me @home`],
      },
    });
    expect(duplicate.isError).toBe(true);
    expect(errorCodeOf(duplicate)).toBe("INVALID_ARGUMENT");
  });

  it("marks multiple todos done and is idempotent", async () => {
    const todos = [new Todo("Ship it @work"), new Todo("Buy milk @home")];
    await backend.save(todos);
    const hashes = await Promise.all(todos.map((todo) => todo.getHash()));
    backend.loadCalls = 0;
    backend.saveCalls = 0;

    const first = await client.callTool({
      name: "update_todos",
      arguments: {
        updates: hashes.map((hash, index) => `${hash} x ${todos[index].text}`),
      },
    });
    expect(linesOf(first)).toHaveLength(2);
    expect(backend.loadCalls).toBe(1);
    expect(backend.saveCalls).toBe(1);
    expect(backend.getTodos().every((todo) => todo.isDone())).toBe(true);

    const second = await client.callTool({
      name: "update_todos",
      arguments: { updates: linesOf(first) },
    });
    expect(linesOf(second)).toHaveLength(2);
    expect(backend.saveCalls).toBe(1);
  });

  it("returns a partial result for a missing hash", async () => {
    const todo = new Todo("Keep me");
    await backend.save([todo]);
    const hash = await todo.getHash();

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

  it("updates every identical todo line when they share a hash", async () => {
    const todos = [new Todo("Dup"), new Todo("Dup"), new Todo("Other")];
    await backend.save(todos);
    const hash = await todos[0].getHash();
    backend.saveCalls = 0;

    const update = await client.callTool({
      name: "update_todos",
      arguments: { updates: [`${hash} (A) Dup`] },
    });

    expect(update.isError).toBeFalsy();
    expect(linesOf(update)).toHaveLength(2);
    expect(backend.getTodos().map((todo) => todo.toString())).toEqual([
      "(A) Dup",
      "(A) Dup",
      "Other",
    ]);
    expect(backend.saveCalls).toBe(1);
  });

  it("deletes every identical todo line when they share a hash", async () => {
    const todos = [new Todo("Dup"), new Todo("Dup"), new Todo("Other")];
    await backend.save(todos);
    const hash = await todos[0].getHash();
    backend.saveCalls = 0;

    const deletion = await client.callTool({
      name: "delete_todos",
      arguments: { hashes: [hash] },
    });

    expect(deletion.isError).toBeFalsy();
    expect(linesOf(deletion)).toHaveLength(2);
    expect(backend.getTodos().map((todo) => todo.toString())).toEqual([
      "Other",
    ]);
    expect(backend.saveCalls).toBe(1);
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
      name: "update_todos",
      arguments: {
        updates: [
          `${hashes[0]} First done`,
          `${hashes[1]} Second done`,
        ],
      },
    });

    expect(linesOf(result)).toHaveLength(2);
    expect(backend.saveCalls).toBe(1);
    expect(backend.getTodos()[0].isDone()).toBe(false);
    expect(backend.getTodos()[1].isDone()).toBe(false);
    expect(backend.getTodos()[2].isDone()).toBe(false);
  });

  it("rejects duplicate hashes in delete_todos", async () => {
    const todo = new Todo("Keep me");
    await backend.save([todo]);
    const hash = await todo.getHash();

    const result = await client.callTool({
      name: "delete_todos",
      arguments: { hashes: [hash, hash] },
    });

    expect(result.isError).toBe(true);
    expect(errorCodeOf(result)).toBe("INVALID_ARGUMENT");
    expect(backend.getTodos()).toHaveLength(1);
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
