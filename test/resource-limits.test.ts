import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebDavBackend } from "../logic/backends/webdav-backend.ts";
import {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_TODOS,
  parsePositiveIntegerEnv,
  resolveMaxFileBytes,
  resolveMaxTodos,
} from "../logic/limits.ts";
import { readTodosFromFile } from "../logic/todo-file-helpers.ts";
import { Todo } from "../logic/todo.ts";
import { addTodoHandler } from "../server.ts";
import { MockBackend } from "./helpers/mock-backend.ts";

describe("resource limit configuration", () => {
  it("uses the documented defaults", () => {
    expect(DEFAULT_MAX_FILE_BYTES).toBe(1024 * 1024);
    expect(DEFAULT_MAX_TODOS).toBe(10_000);
    expect(resolveMaxFileBytes({})).toBe(DEFAULT_MAX_FILE_BYTES);
    expect(resolveMaxTodos({})).toBe(DEFAULT_MAX_TODOS);
    expect(resolveMaxFileBytes({ TODOTXT_MCP_MAX_FILE_BYTES: "" }))
      .toBe(DEFAULT_MAX_FILE_BYTES);
  });

  it("reads positive integer overrides from the environment", () => {
    expect(resolveMaxFileBytes({ TODOTXT_MCP_MAX_FILE_BYTES: "2048" }))
      .toBe(2048);
    expect(resolveMaxTodos({ TODOTXT_MCP_MAX_TODOS: "42" })).toBe(42);
  });

  it.each(["0", "-1", "1.5", "abc", "Infinity"])(
    "rejects invalid limit %s with a clear error",
    (value) => {
      expect(() =>
        parsePositiveIntegerEnv(value, 100, "TODOTXT_MCP_MAX_TODOS")
      ).toThrow(/TODOTXT_MCP_MAX_TODOS.*positive integer/);
    },
  );
});

describe("todo file size cap", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "todo-txt-mcp-limits-"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it("rejects an oversized file before parsing it", async () => {
    const filename = join(directory, "todo.txt");
    await writeFile(filename, "0123456789");

    await expect(
      readTodosFromFile(filename, { maxFileBytes: 5 }),
    ).rejects.toThrow(/too large.*10 bytes.*5-byte limit/);
  });

  it("accepts a file exactly at the limit", async () => {
    const filename = join(directory, "todo.txt");
    await writeFile(filename, "12345");

    const todos = await readTodosFromFile(filename, { maxFileBytes: 5 });
    expect(todos).toHaveLength(1);
    expect(todos[0].text).toBe("12345");
  });

  it("honors TODOTXT_MCP_MAX_FILE_BYTES from the environment", async () => {
    vi.stubEnv("TODOTXT_MCP_MAX_FILE_BYTES", "5");
    const filename = join(directory, "todo.txt");
    await writeFile(filename, "0123456789");

    await expect(readTodosFromFile(filename)).rejects.toThrow(
      /TODOTXT_MCP_MAX_FILE_BYTES/,
    );
  });

  it("checks the byte length of WebDAV Content-Length before reading", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("ignored", {
        status: 200,
        headers: { "Content-Length": "10" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new WebDavBackend(
        "https://dav.example.com/todo.txt",
        undefined,
        undefined,
        { maxFileBytes: 5, baseDelayMs: 0 },
      ).load(),
    ).rejects.toThrow(/too large/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("checks the actual WebDAV body length when Content-Length is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("0123456789", { status: 200 })),
    );

    await expect(
      new WebDavBackend(
        "https://dav.example.com/todo.txt",
        undefined,
        undefined,
        { maxFileBytes: 5, baseDelayMs: 0 },
      ).load(),
    ).rejects.toThrow(/too large/);
  });
});

describe("max total todos cap", () => {
  let backend: MockBackend;

  beforeEach(() => {
    backend = new MockBackend();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects an add that would exceed the limit without saving", async () => {
    vi.stubEnv("TODOTXT_MCP_MAX_TODOS", "2");
    await backend.save([new Todo("one"), new Todo("two")]);
    const saveSpy = vi.spyOn(backend, "save");

    const result = await addTodoHandler(backend, { todos: ["three"] });

    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toContain("limit is 2");
    expect(backend.getTodos()).toHaveLength(2);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("allows an add that exactly reaches the limit", async () => {
    vi.stubEnv("TODOTXT_MCP_MAX_TODOS", "3");
    await backend.save([new Todo("one")]);

    const result = await addTodoHandler(backend, { todos: ["two", "three"] });

    expect(result).not.toMatchObject({ isError: true });
    expect(backend.getTodos()).toHaveLength(3);
  });
});
