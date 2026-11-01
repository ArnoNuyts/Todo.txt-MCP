import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addTodosHandler,
  changesSinceHandler,
  createTodoMcpServer,
  deleteCompletedHandler,
  deleteTodosHandler,
  exportTodosHandler,
  getTodoHandler,
  importTodosHandler,
  listTodosHandler,
  summaryHandler,
} from "../server.ts";
import {
  computeContentVersion,
  serializeTodoContent,
} from "../logic/content.ts";
import type { TodoBackend } from "../logic/backend.ts";
import { Todo } from "../logic/todo.ts";
import { guardTool, mapError, toolError, ToolFailure } from "../logic/tool-errors.ts";
import { MockBackend } from "./helpers/mock-backend.ts";

interface ToolErrorBody {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: {
    error?: {
      code: string;
      message: string;
      details?: Record<string, unknown>;
    };
  };
}

function errorOf(result: unknown) {
  const body = result as ToolErrorBody;
  const error = body.structuredContent?.error;
  if (error === undefined) {
    throw new Error(`Expected a structured error, got: ${JSON.stringify(result)}`);
  }
  return error;
}

function structured<T>(result: unknown): T {
  return (result as { structuredContent: T }).structuredContent;
}

function textOf(result: unknown): string {
  return (result as ToolErrorBody).content.map((item) => item.text ?? "")
    .join("\n");
}

describe("structured tool errors", () => {
  it("returns the canonical error shape", () => {
    expect(toolError("INVALID_ARGUMENT", "Bad input", { field: "hash" }))
      .toEqual({
        isError: true,
        content: [{ type: "text", text: "Bad input" }],
        structuredContent: {
          error: {
            code: "INVALID_ARGUMENT",
            message: "Bad input",
            details: { field: "hash" },
          },
        },
      });
  });

  it("maps zod validation failures to INVALID_ARGUMENT", async () => {
    const result = await addTodosHandler(new MockBackend(), {
      todos: ["a".repeat(2001)],
    });
    const error = errorOf(result);

    expect(result).toMatchObject({ isError: true });
    expect(error.code).toBe("INVALID_ARGUMENT");
    expect(error.message).toContain("Invalid arguments");
    expect(error.details?.issues).toBeInstanceOf(Array);
  });

  it("maps unexpected exceptions to BACKEND_ERROR without a stack trace", async () => {
    const failingBackend: TodoBackend = {
      load: () => Promise.reject(new Error("backend exploded")),
      save: () => Promise.resolve(),
    };

    const result = await listTodosHandler(failingBackend, {});
    const error = errorOf(result);

    expect(result).toMatchObject({ isError: true });
    expect(error).toEqual({
      code: "BACKEND_ERROR",
      message: "backend exploded",
    });
    expect(textOf(result)).toBe("backend exploded");
    expect(textOf(result)).not.toContain("at ");
  });

  it("maps a ToolFailure code and guards thrown errors", async () => {
    const direct = mapError(new Error("plain failure"));
    expect(direct.structuredContent.error.code).toBe("BACKEND_ERROR");

    const guarded = await guardTool(() =>
      Promise.reject(new ToolFailure("UNSUPPORTED", "nope"))
    );
    expect(guarded).toEqual(toolError("UNSUPPORTED", "nope"));
  });

  it("returns TODO_NOT_FOUND with hash and hint for a missing todo", async () => {
    const hash = "0123456789abcdef";
    const result = await getTodoHandler(new MockBackend(), { hash });

    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toBe(
      `Todo with hash ${hash} not found. Call list_todos to refresh hashes.`,
    );
    expect(errorOf(result)).toEqual({
      code: "TODO_NOT_FOUND",
      message:
        `Todo with hash ${hash} not found. Call list_todos to refresh hashes.`,
      details: { hash, hint: "call list_todos to refresh hashes" },
    });
  });

  it("reports partial batch misses as succeeded/failed", async () => {
    const backend = new MockBackend();
    const todo = new Todo("keep me");
    await backend.save([todo]);
    const hash = await todo.getHash();

    const result = await deleteTodosHandler(backend, {
      hashes: [hash, "0123456789abcdef"],
    });
    const content = structured<{
      succeeded: Array<{ hash: string }>;
      failed: Array<{ hash: string; code: string; message: string }>;
    }>(result);

    expect(content.succeeded).toEqual([expect.objectContaining({ hash })]);
    expect(content.failed).toEqual([{
      hash: "0123456789abcdef",
      code: "TODO_NOT_FOUND",
      message: "Todo with hash 0123456789abcdef not found.",
    }]);
  });
});

describe("content versioning", () => {
  const backend = new MockBackend();

  beforeEach(() => {
    backend.reset();
  });

  it("exposes a stable SHA-256 version in list_todos", async () => {
    await backend.save([new Todo("one"), new Todo("two")]);
    const version = computeContentVersion(backend.getTodos());

    expect(version).toMatch(/^[0-9a-f]{64}$/);

    const first = structured<{ version: string }>(
      await listTodosHandler(backend, {}),
    );
    const second = structured<{ version: string }>(
      await listTodosHandler(backend, {}),
    );
    expect(first.version).toBe(version);
    expect(second.version).toBe(version);
    expect(first.version).toBe(second.version);

    await addTodosHandler(backend, { todos: ["three"] });
    const changed = structured<{ version: string }>(
      await listTodosHandler(backend, {}),
    );
    expect(changed.version).not.toBe(version);
  });

  it("gets a single todo by hash with the content version", async () => {
    const todo = new Todo("only todo +proj @ctx");
    await backend.save([todo]);
    const hash = await todo.getHash();

    const result = await getTodoHandler(backend, { hash });
    const content = structured<{
      todo: { hash: string; text: string };
      version: string;
    }>(result);

    expect(content.todo).toMatchObject({ hash, text: "only todo +proj @ctx" });
    expect(content.version).toBe(computeContentVersion(backend.getTodos()));
    expect(textOf(result)).toBe(`[${hash}] only todo +proj @ctx`);
  });

  it("summarizes counts by status, context, project, priority and overdue", async () => {
    await backend.save([
      new Todo("(A) 2024-01-01 overdue task +Work @Home due:2000-01-01"),
      new Todo("(B) second task +work @home"),
      new Todo("plain task +home @Errands"),
      new Todo("x 2024-04-01 2024-01-01 done task +archive @office"),
    ]);

    const content = structured<{
      version: string;
      total: number;
      open: number;
      done: number;
      overdue: number;
      status: { todo: number; done: number };
      contexts: Record<string, number>;
      projects: Record<string, number>;
      priorities: Record<string, number>;
    }>(await summaryHandler(backend, {}));

    expect(content.version).toBe(computeContentVersion(backend.getTodos()));
    expect(content.total).toBe(4);
    expect(content.open).toBe(3);
    expect(content.done).toBe(1);
    expect(content.overdue).toBe(1);
    expect(content.status).toEqual({ todo: 3, done: 1 });
    expect(content.contexts).toEqual({
      errands: 1,
      home: 2,
      office: 1,
    });
    expect(content.projects).toEqual({
      archive: 1,
      home: 1,
      work: 2,
    });
    expect(content.priorities).toEqual({ a: 1, b: 1, none: 2 });
  });

  it("exports the file content together with its version", async () => {
    await backend.save([new Todo("one"), new Todo("x 2024-01-01 2023-12-01 two")]);
    const expected = serializeTodoContent(backend.getTodos());

    const result = await exportTodosHandler(backend, {});
    const content = structured<{ content: string; version: string }>(result);

    expect(content.content).toBe(expected);
    expect(content.version).toBe(computeContentVersion(backend.getTodos()));
    expect(textOf(result)).toBe(expected);
  });

  it("reports changes_since without content when the version matches", async () => {
    await backend.save([new Todo("one")]);
    const version = computeContentVersion(backend.getTodos());

    const unchanged = structured<{
      changed: boolean;
      version: string;
      content?: string;
    }>(await changesSinceHandler(backend, { version }));

    expect(unchanged).toEqual({ changed: false, version });
    expect(unchanged.content).toBeUndefined();

    await addTodosHandler(backend, { todos: ["two"] });
    const changed = structured<{
      changed: boolean;
      version: string;
      content?: string;
    }>(await changesSinceHandler(backend, { version }));

    expect(changed.changed).toBe(true);
    expect(changed.version).not.toBe(version);
    expect(changed.content).toBe(serializeTodoContent(backend.getTodos()));
  });
});

describe("import_todos", () => {
  const backend = new MockBackend();

  beforeEach(async () => {
    backend.reset();
    await backend.save([new Todo("one")]);
    backend.loadCalls = 0;
    backend.saveCalls = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("merges imported content and reports the diff", async () => {
    const before = computeContentVersion(backend.getTodos());

    const result = await importTodosHandler(backend, {
      content: "two\nthree\n",
      mode: "merge",
    });
    const content = structured<{
      dryRun: boolean;
      mode: string;
      changed: boolean;
      version: string;
      total: number;
      importedCount: number;
      diff: { added: number; removed: number; unchanged: number };
    }>(result);

    expect(content).toMatchObject({
      dryRun: false,
      mode: "merge",
      changed: true,
      total: 3,
      importedCount: 2,
      diff: { added: 2, removed: 0, unchanged: 1 },
    });
    expect(content.version).not.toBe(before);
    expect(content.version).toBe(computeContentVersion(backend.getTodos()));
    expect(backend.getTodos().map((todo) => todo.text)).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  it("does not duplicate existing todos in merge mode", async () => {
    const before = computeContentVersion(backend.getTodos());
    const existing = serializeTodoContent(backend.getTodos());

    const result = await importTodosHandler(backend, {
      content: existing,
      mode: "merge",
    });
    const content = structured<{
      changed: boolean;
      version: string;
      total: number;
      diff: { added: number; removed: number; unchanged: number };
    }>(result);

    expect(content).toMatchObject({
      changed: false,
      version: before,
      total: 1,
      diff: { added: 0, removed: 0, unchanged: 1 },
    });
    expect(backend.getTodos().map((todo) => todo.text)).toEqual(["one"]);
    expect(backend.saveCalls).toBe(0);
  });

  it("adds only new todos and collapses duplicates in the import payload", async () => {
    const result = await importTodosHandler(backend, {
      content: "one\ntwo\ntwo\nthree\n",
      mode: "merge",
    });
    const content = structured<{
      changed: boolean;
      total: number;
      importedCount: number;
      diff: { added: number; removed: number; unchanged: number };
    }>(result);

    expect(content).toMatchObject({
      changed: true,
      total: 3,
      importedCount: 4,
      diff: { added: 2, removed: 0, unchanged: 1 },
    });
    expect(backend.getTodos().map((todo) => todo.text)).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  it("replaces all content in replace mode", async () => {
    await importTodosHandler(backend, {
      content: "fresh\n",
      mode: "replace",
    });

    expect(backend.getTodos().map((todo) => todo.text)).toEqual(["fresh"]);
  });

  it("rejects a stale expectedVersion with CONFLICT and writes nothing", async () => {
    const stale = "0".repeat(64);
    const original = backend.getTodos();

    const result = await importTodosHandler(backend, {
      content: "two\n",
      mode: "merge",
      expectedVersion: stale,
    });
    const error = errorOf(result);

    expect(result).toMatchObject({ isError: true });
    expect(error.code).toBe("CONFLICT");
    expect(error.details).toEqual({
      expectedVersion: stale,
      currentVersion: computeContentVersion(original),
    });
    expect(backend.getTodos()).toEqual(original);
    expect(backend.saveCalls).toBe(0);
  });

  it("returns a diff for dryRun without writing", async () => {
    const before = computeContentVersion(backend.getTodos());

    const result = await importTodosHandler(backend, {
      content: "two\n",
      mode: "merge",
      dryRun: true,
    });
    const content = structured<{
      dryRun: boolean;
      changed: boolean;
      version: string;
      total: number;
      diff: { added: number; removed: number; unchanged: number };
    }>(result);

    expect(content).toMatchObject({
      dryRun: true,
      changed: true,
      version: before,
      total: 2,
      diff: { added: 1, removed: 0, unchanged: 1 },
    });
    expect(textOf(result)).toContain("Nothing was saved");
    expect(backend.getTodos().map((todo) => todo.text)).toEqual(["one"]);
    expect(backend.saveCalls).toBe(0);
  });

  it("enforces the max todo count limit", async () => {
    vi.stubEnv("TODOTXT_MCP_MAX_TODOS", "2");

    const result = await importTodosHandler(backend, {
      content: "two\nthree\nfour\n",
      mode: "merge",
    });

    expect(result).toMatchObject({ isError: true });
    expect(errorOf(result).code).toBe("LIMIT_EXCEEDED");
    expect(backend.getTodos().map((todo) => todo.text)).toEqual(["one"]);
    expect(backend.saveCalls).toBe(0);
  });
});

describe("dryRun deletions", () => {
  it("delete_todos reports candidates without writing", async () => {
    const backend = new MockBackend();
    const todo = new Todo("delete me");
    await backend.save([todo]);
    const hash = await todo.getHash();
    backend.saveCalls = 0;

    const result = await deleteTodosHandler(backend, {
      hashes: [hash],
      dryRun: true,
    });
    const content = structured<{
      deleted: Array<{ hash: string }>;
      dryRun?: boolean;
    }>(result);

    expect(content.deleted).toEqual([expect.objectContaining({ hash })]);
    expect(content.dryRun).toBe(true);
    expect(textOf(result)).toContain("Would delete");
    expect(backend.getTodos()).toHaveLength(1);
    expect(backend.saveCalls).toBe(0);
  });

  it("delete_completed reports candidates without writing", async () => {
    const backend = new MockBackend();
    await backend.save([
      new Todo("x 2024-01-01 2023-12-01 done"),
      new Todo("active"),
    ]);
    backend.saveCalls = 0;

    const result = await deleteCompletedHandler(backend, { dryRun: true });
    const content = structured<{ deletedCount: number; dryRun?: boolean }>(
      result,
    );

    expect(content.deletedCount).toBe(1);
    expect(content.dryRun).toBe(true);
    expect(backend.getTodos()).toHaveLength(2);
    expect(backend.saveCalls).toBe(0);
  });
});

describe("MCP resources", () => {
  let backend: MockBackend;
  let client: Client;
  let server: ReturnType<typeof createTodoMcpServer>;

  beforeEach(async () => {
    backend = new MockBackend();
    await backend.save([
      new Todo("open one @Home"),
      new Todo("open two @work"),
      new Todo("x 2024-01-01 2023-12-01 done one @Home"),
    ]);
    backend.loadCalls = 0;
    backend.saveCalls = 0;

    server = createTodoMcpServer(backend);
    const [clientTransport, serverTransport] = InMemoryTransport
      .createLinkedPair();
    client = new Client({
      name: "todo-txt-mcp-resource-test",
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

  it("lists the static resources and the context template", async () => {
    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri).sort()).toEqual([
      "todo://active",
      "todo://file",
    ]);
    for (const resource of resources) {
      expect(resource.mimeType).toBe("text/plain");
    }

    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((template) => template.uriTemplate))
      .toContain("todo://context/{name}");
  });

  it("serves the versioning tools over MCP", async () => {
    const length = backend.getTodos().length;
    const summaryResult = await client.callTool({
      name: "summary",
      arguments: {},
    }) as {
      structuredContent?: {
        total: number;
        open: number;
        done: number;
        version: string;
      };
    };
    expect(summaryResult.structuredContent).toMatchObject({
      total: length,
      open: 2,
      done: 1,
    });

    const version = summaryResult.structuredContent!.version;
    const exportResult = await client.callTool({
      name: "export_todos",
      arguments: {},
    }) as { structuredContent?: { content: string; version: string } };
    expect(exportResult.structuredContent?.version).toBe(version);
    expect(exportResult.structuredContent?.content).toBe(
      serializeTodoContent(backend.getTodos()),
    );

    const changes = await client.callTool({
      name: "changes_since",
      arguments: { version },
    }) as { structuredContent?: { changed: boolean } };
    expect(changes.structuredContent?.changed).toBe(false);

    const hash = await backend.getTodos()[0].getHash();
    const fetched = await client.callTool({
      name: "get_todo",
      arguments: { hash },
    }) as {
      structuredContent?: { todo: { hash: string }; version: string };
    };
    expect(fetched.structuredContent?.todo.hash).toBe(hash);
    expect(fetched.structuredContent?.version).toBe(version);

    const missing = await client.callTool({
      name: "get_todo",
      arguments: { hash: "0".repeat(16) },
    }) as {
      isError?: boolean;
      structuredContent?: { error?: { code: string } };
    };
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent?.error?.code).toBe("TODO_NOT_FOUND");

    const dryRun = await client.callTool({
      name: "import_todos",
      arguments: { content: "imported\n", mode: "merge", dryRun: true },
    }) as { structuredContent?: { dryRun: boolean; changed: boolean } };
    expect(dryRun.structuredContent).toMatchObject({
      dryRun: true,
      changed: true,
    });
    expect(backend.getTodos()).toHaveLength(length);
  });

  it("reads the whole file without mutating the backend", async () => {
    const result = await client.readResource({ uri: "todo://file" });
    const [content] = result.contents as Array<{ text?: string }>;

    expect(content.text).toBe(serializeTodoContent(backend.getTodos()));
    expect(backend.saveCalls).toBe(0);
  });

  it("reads only open todos from todo://active", async () => {
    const result = await client.readResource({ uri: "todo://active" });
    const [content] = result.contents as Array<{ text?: string }>;

    expect(content.text).toBe("open one @Home\nopen two @work\n");
    expect(content.text).not.toContain("done one");
    expect(backend.saveCalls).toBe(0);
  });

  it("reads one context through the resource template", async () => {
    const result = await client.readResource({ uri: "todo://context/home" });
    const [content] = result.contents as Array<{ text?: string }>;

    expect(content.text).toBe("open one @Home\n");
    expect(backend.saveCalls).toBe(0);
  });
});
