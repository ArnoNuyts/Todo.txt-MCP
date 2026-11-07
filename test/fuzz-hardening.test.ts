import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTodoMcpServer } from "../server.ts";
import { LocalFileBackend } from "../logic/backends/local-file-backend.ts";
import {
  computeRetryDelayMs,
  WebDavBackend,
} from "../logic/backends/webdav-backend.ts";
import { Todo } from "../logic/todo.ts";
import { MockBackend } from "./helpers/mock-backend.ts";

const url = "https://dav.example.com/todo.txt";
const fastRetry = { baseDelayMs: 0, maxDelayMs: 0 };
const temporaryDirectories: string[] = [];

async function makeTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "todo-txt-mcp-hardening-"));
  temporaryDirectories.push(directory);
  return directory;
}

interface ToolTextResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: { error?: { code?: string } };
}

function textOf(result: unknown): string {
  return (result as ToolTextResult).content
    .map((item) => item.text ?? "")
    .join("\n");
}

function errorCodeOf(result: unknown): string | undefined {
  return (result as ToolTextResult).structuredContent?.error?.code;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("unsafe todo text", () => {
  let backend: MockBackend;
  let client: Client;
  let server: ReturnType<typeof createTodoMcpServer>;

  beforeEach(async () => {
    backend = new MockBackend();
    server = createTodoMcpServer(backend);
    const [clientTransport, serverTransport] = InMemoryTransport
      .createLinkedPair();
    client = new Client({
      name: "todo-txt-mcp-hardening-test",
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

  const UNSAFE = [
    { name: "NUL", value: "\u0000" },
    { name: "SOH control character", value: "\u0001" },
    { name: "escape control character", value: "\u001b" },
    { name: "DEL control character", value: "\u007f" },
    { name: "C1 control character", value: "\u0085" },
    { name: "lone surrogate", value: "\ud800" },
  ];

  it.each(UNSAFE)("rejects an embedded $name in add_todos", async ({ value }) => {
    await backend.save([new Todo("keep me")]);
    backend.saveCalls = 0;

    const result = await client.callTool({
      name: "add_todos",
      arguments: { todos: [`alpha${value}beta`] },
    });

    expect(result.isError).toBe(true);
    expect(errorCodeOf(result)).toBe("INVALID_ARGUMENT");
    expect(backend.saveCalls).toBe(0);
    expect(backend.getTodos().map((todo) => todo.toString())).toEqual([
      "keep me",
    ]);
  });

  it.each(UNSAFE)(
    "rejects an embedded $name in update_todos",
    async ({ value }) => {
      const todo = new Todo("keep me");
      await backend.save([todo]);
      const hash = await todo.getHash();
      backend.saveCalls = 0;

      const result = await client.callTool({
        name: "update_todos",
        arguments: { updates: [`${hash} alpha${value}beta`] },
      });

      expect(result.isError).toBe(true);
      expect(errorCodeOf(result)).toBe("INVALID_ARGUMENT");
      expect(backend.saveCalls).toBe(0);
    },
  );

  it("refuses a hash collision between different todo lines", async () => {
    const first = new Todo("first");
    const second = new Todo("second");
    await backend.save([first, second]);
    vi.spyOn(first, "getHash").mockResolvedValue("collision");
    vi.spyOn(second, "getHash").mockResolvedValue("collision");
    backend.saveCalls = 0;

    const result = await client.callTool({
      name: "delete_todos",
      arguments: { hashes: ["collision"] },
    });

    expect(result.isError).toBe(true);
    expect(errorCodeOf(result)).toBe("CONFLICT");
    expect(textOf(result)).toContain("hash collision");
    expect(backend.saveCalls).toBe(0);
    expect(backend.getTodos().map((todo) => todo.toString())).toEqual([
      "first",
      "second",
    ]);
  });

  it("still allows a tab inside todo text", async () => {
    const result = await client.callTool({
      name: "add_todos",
      arguments: { todos: ["column\tseparated"] },
    });

    expect(result.isError).toBeFalsy();
    expect(backend.getTodos()[0].text).toBe("column\tseparated");
  });
});

describe("byte-stable serialization", () => {
  it("returns an untouched raw line byte-for-byte", () => {
    const raw = "alpha due:2020-01-01 beta";

    expect(new Todo(raw).toString()).toBe(raw);
  });

  it("keeps CRLF and odd tag placement for untouched lines", async () => {
    const directory = await makeTempDirectory();
    const filename = join(directory, "todo.txt");
    const untouched = [
      "alpha due:2020-01-01 beta",
      "task tail due:2020-01-01",
      "trail\r",
    ];
    await writeFile(filename, `${untouched.join("\n")}\n`, "utf8");

    const backend = new LocalFileBackend(filename);
    const todos = await backend.load();
    todos.push(new Todo("new item"));
    await backend.save(todos);

    expect(await readFile(filename, "utf8")).toBe(
      `${[...untouched, "new item"].join("\n")}\n`,
    );
  });

  it("gives raw-distinct lines that canonicalize identically different hashes", async () => {
    const first = new Todo("task due:2020-01-01 tail");
    const second = new Todo("task tail due:2020-01-01");

    expect(await first.getHash()).not.toBe(await second.getHash());
  });

  it("canonicalizes a line after it is modified", () => {
    const todo = new Todo("task due:2020-01-01 tail");
    todo.setTag("due", "2021-01-01");

    expect(todo.toString()).toBe("task tail due:2021-01-01");
  });
});

describe("WebDAV response validation", () => {
  it("rejects a 200 response whose body is not text/plain", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("<html>error</html>\n", {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        })
      ),
    );

    await expect(new WebDavBackend(url).load()).rejects.toThrow(
      /plain-text body/,
    );
  });

  it.each([
    { name: "no content type", headers: {} },
    {
      name: "application/octet-stream",
      headers: { "Content-Type": "application/octet-stream" },
    },
  ])("rejects an HTML error page with $name", async ({ headers }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const response = new Response(
          "<!DOCTYPE html><html><body>login</body></html>\n",
          { status: 200, headers },
        );
        // The Response constructor adds a text/plain default for string
        // bodies; a real proxy can omit the header entirely.
        if (Object.keys(headers).length === 0) {
          response.headers.delete("content-type");
        }
        return response;
      }),
    );

    await expect(new WebDavBackend(url).load()).rejects.toThrow(
      /HTML error page/,
    );
  });

  it.each([
    "<?xml version=\"1.0\"?><error>login</error>",
    "<!-- proxy error --><html>login</html>",
  ])("rejects a comment/XML-led error page without a content type", async (body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const response = new Response(body, { status: 200 });
        response.headers.delete("content-type");
        return response;
      }),
    );

    await expect(new WebDavBackend(url).load()).rejects.toThrow(
      /HTML error page/,
    );
  });

  it("accepts a text/plain todo that starts with an HTML tag", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("<html> is a tag\n", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        })
      ),
    );

    await expect(new WebDavBackend(url).load()).resolves.toHaveLength(1);
  });

  it("accepts text/plain with parameters and an absent content type", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("first\n", {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        })
      ),
    );
    await expect(new WebDavBackend(url).load()).resolves.toHaveLength(1);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("second\n", { status: 200 })),
    );
    await expect(new WebDavBackend(url).load()).resolves.toHaveLength(1);
  });
});

describe("WebDAV write outcome verification", () => {
  it("succeeds when the PUT was applied but the server answered 500", async () => {
    let serverContent = "old\n";
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        return new Response(serverContent, {
          status: 200,
          headers: { ETag: '"current"' },
        });
      }
      serverContent = String(init?.body ?? "");
      return new Response("", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const backend = new WebDavBackend(url, undefined, undefined, fastRetry);
    await backend.withLock(async () => {
      await backend.load();
      await backend.save([new Todo("new")]);
    });

    expect(serverContent).toContain("new");
    expect(serverContent).not.toContain("old");
    expect(fetchMock.mock.calls.at(-1)?.[1]).toMatchObject({
      method: "GET",
      redirect: "manual",
      cache: "no-store",
    });
  });

  it("confirms an applied write when the server normalises line endings", async () => {
    let serverContent = "old\n";
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        return new Response(serverContent, {
          status: 200,
          headers: { ETag: '"current"' },
        });
      }
      // Store the body with CRLF, as some servers do.
      serverContent = String(init?.body ?? "").replace(/\n/g, "\r\n");
      return new Response("", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const backend = new WebDavBackend(url, undefined, undefined, fastRetry);
    await backend.withLock(async () => {
      await backend.load();
      await backend.save([new Todo("new")]);
    });

    expect(serverContent).toBe("new\r\n");
  });

  it("reports an unconfirmed outcome when the write and the check both fail", async () => {
    let getCount = 0;
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        getCount += 1;
        if (getCount === 1) {
          return new Response("old\n", {
            status: 200,
            headers: { ETag: '"current"' },
          });
        }
        return new Response("", { status: 503 });
      }
      return new Response("", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const backend = new WebDavBackend(url, undefined, undefined, fastRetry);
    await expect(
      backend.withLock(async () => {
        await backend.load();
        await backend.save([new Todo("new")]);
      }),
    ).rejects.toThrow(/could not be confirmed/);
  });

  it("does not read a probe body larger than the configured limit", async () => {
    let getCount = 0;
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        getCount += 1;
        if (getCount === 1) {
          return new Response("old\n", {
            status: 200,
            headers: { ETag: '"current"' },
          });
        }
        return new Response("ignored", {
          status: 200,
          headers: {
            "Content-Length": "999999999",
            ETag: '"current"',
          },
        });
      }
      return new Response("", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const backend = new WebDavBackend(url, undefined, undefined, {
      ...fastRetry,
      maxFileBytes: 10,
    });
    await expect(
      backend.withLock(async () => {
        await backend.load();
        await backend.save([new Todo("new")]);
      }),
    ).rejects.toThrow(/could not be confirmed/);
  });

  it("reports a plain failure when the write did not apply and the file is readable", async () => {
    let serverContent = "old\n";
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        return new Response(serverContent, {
          status: 200,
          headers: { ETag: '"current"' },
        });
      }
      // The write is refused before it reaches storage.
      return new Response("", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const backend = new WebDavBackend(url, undefined, undefined, fastRetry);
    await expect(
      backend.withLock(async () => {
        await backend.load();
        await backend.save([new Todo("new")]);
      }),
    ).rejects.toThrow(/Failed to save todos to WebDAV/);

    expect(serverContent).toBe("old\n");
  });
});

describe("Retry-After bound", () => {
  it("caps a hostile Retry-After well below client timeouts", () => {
    expect(computeRetryDelayMs(1, 60 * 60 * 1000, {})).toBe(5_000);
  });
});

describe("read-only todo file", () => {
  it("refuses to replace a read-only file", async () => {
    const directory = await makeTempDirectory();
    const filename = join(directory, "todo.txt");
    await writeFile(filename, "old\n", "utf8");
    await chmod(filename, 0o400);

    const backend = new LocalFileBackend(filename);
    await expect(backend.save([new Todo("new")])).rejects.toThrow(
      /read-only/,
    );
    expect(await readFile(filename, "utf8")).toBe("old\n");
  });
});

describe("recurrence results", () => {
  it("returns the spawned recurrence hash alongside the completed todo", async () => {
    const backend = new MockBackend();
    const server = createTodoMcpServer(backend);
    const [clientTransport, serverTransport] = InMemoryTransport
      .createLinkedPair();
    const client = new Client({
      name: "todo-txt-mcp-hardening-test",
      version: "1.0.0",
    });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);

    try {
      const todo = new Todo("Task due:2024-06-20 rec:+1w");
      await backend.save([todo]);
      const hash = await todo.getHash();

      const result = await client.callTool({
        name: "update_todos",
        arguments: {
          updates: [`${hash} x 2024-06-10 Task due:2024-06-20 rec:+1w`],
        },
      });

      expect(result.isError).toBeFalsy();
      const lines = textOf(result).split("\n");
      expect(lines).toHaveLength(2);
      const storedHashes = await Promise.all(
        backend.getTodos().map((stored) => stored.getHash()),
      );
      for (const line of lines) {
        expect(storedHashes).toContain(line.split(" ")[0]);
      }
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });
});
