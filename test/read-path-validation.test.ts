import { spawnSync } from "node:child_process";
import {
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
import { WebDavBackend } from "../logic/backends/webdav-backend.ts";
import { createReadinessProbe } from "../logic/readiness.ts";
import {
  DEFAULT_MAX_LINE_CHARS,
  DEFAULT_MAX_READ_TODOS,
  ReadLineLengthLimitError,
  ReadTodoCountLimitError,
  resolveMaxLineChars,
  resolveMaxReadTodos,
  UnsafeTodoFileContentError,
} from "../logic/limits.ts";
import {
  readTodosFromFile,
  writeTodosToFile,
} from "../logic/todo-file-helpers.ts";
import { validateTodoFileContent } from "../logic/todo-file-validation.ts";

const LIMITS = {
  maxReadTodos: DEFAULT_MAX_READ_TODOS,
  maxLineChars: DEFAULT_MAX_LINE_CHARS,
};

let tempDir = "";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "todo-txt-mcp-read-path-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

async function writeTodoFile(name: string, content: string): Promise<string> {
  const filename = join(tempDir, name);
  await writeFile(filename, content, "utf8");
  return filename;
}

describe("read limit configuration", () => {
  it("uses the documented read defaults", () => {
    expect(DEFAULT_MAX_READ_TODOS).toBe(50_000);
    expect(DEFAULT_MAX_LINE_CHARS).toBe(8_192);
    expect(resolveMaxReadTodos({})).toBe(DEFAULT_MAX_READ_TODOS);
    expect(resolveMaxLineChars({})).toBe(DEFAULT_MAX_LINE_CHARS);
    expect(resolveMaxReadTodos({ TODOTXT_MCP_MAX_READ_TODOS: "7" })).toBe(7);
    expect(resolveMaxLineChars({ TODOTXT_MCP_MAX_LINE_CHARS: "99" })).toBe(99);
  });

  it.each(["0", "-1", "1.5", "abc"])(
    "rejects invalid read limit %s",
    (value) => {
      expect(() =>
        resolveMaxReadTodos({ TODOTXT_MCP_MAX_READ_TODOS: value })
      ).toThrow(/TODOTXT_MCP_MAX_READ_TODOS.*positive integer/);
      expect(() =>
        resolveMaxLineChars({ TODOTXT_MCP_MAX_LINE_CHARS: value })
      ).toThrow(/TODOTXT_MCP_MAX_LINE_CHARS.*positive integer/);
    },
  );
});

describe("structural validation", () => {
  it("rejects 500,000 lines quickly without splitting them first", () => {
    const data = "a\n".repeat(500_000);
    const startedAt = performance.now();

    expect(() => validateTodoFileContent(data, LIMITS)).toThrow(
      ReadTodoCountLimitError,
    );

    // Generous bound: the point is one linear indexOf scan, not a large line
    // array or a 500k-substring allocation.
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it("accepts exactly 50,000 lines and rejects 50,001", () => {
    expect(validateTodoFileContent("a\n".repeat(50_000), LIMITS)).toHaveLength(
      50_001,
    );

    expect(() => validateTodoFileContent("a\n".repeat(50_001), LIMITS)).toThrow(
      ReadTodoCountLimitError,
    );
  });

  it("counts a final line without a trailing newline", () => {
    const data = Array.from({ length: 50_001 }, () => "a").join("\n");

    expect(() => validateTodoFileContent(data, LIMITS)).toThrow(
      /contains 50001 lines/,
    );
  });

  it("accepts a line of 8,192 characters and rejects 8,193", () => {
    expect(validateTodoFileContent("a".repeat(8_192), LIMITS)).toHaveLength(1);

    expect(() => validateTodoFileContent("a".repeat(8_193), LIMITS)).toThrow(
      ReadLineLengthLimitError,
    );
    try {
      validateTodoFileContent("aaa\n" + "a".repeat(8_193), LIMITS);
      expect.unreachable("expected the long line to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(ReadLineLengthLimitError);
      expect(error).toMatchObject({ lineNumber: 2, lineLength: 8_193 });
    }
  });

  it("rejects a 500,000-line file through the file helper", async () => {
    const filename = await writeTodoFile("huge.txt", "a\n".repeat(500_000));

    await expect(readTodosFromFile(filename)).rejects.toBeInstanceOf(
      ReadTodoCountLimitError,
    );
  });

  it("reports a bounded readiness failure without leaking file content", async () => {
    const filename = await writeTodoFile(
      "too-many-for-readiness.txt",
      "a\n".repeat(50_001),
    );

    const result = await createReadinessProbe(
      new LocalFileBackend(filename),
      1_000,
    )();

    expect(result.ready).toBe(false);
    expect(result.reason).toContain("50001");
    expect(result.reason).not.toContain("a\na\na");
  });
});

describe("unsafe line content", () => {
  it.each([
    { name: "NUL", value: "\u0000" },
    { name: "SOH", value: "\u0001" },
    { name: "bare carriage return", value: "inside\rrest" },
    { name: "line separator", value: "\u2028" },
    { name: "paragraph separator", value: "\u2029" },
    { name: "escape", value: "\u001b" },
    { name: "DEL", value: "\u007f" },
    { name: "C1 control", value: "\u0085" },
  ])("rejects $name on the read path", async ({ value }) => {
    const filename = await writeTodoFile(
      `${value.length}.txt`,
      `innocent${value}tail\n`,
    );

    await expect(readTodosFromFile(filename)).rejects.toBeInstanceOf(
      UnsafeTodoFileContentError,
    );
  });

  it("keeps the error bounded: line number and code point only", async () => {
    const filename = await writeTodoFile("poison.txt", "safe\nbad\u0000secret\n");

    await expect(readTodosFromFile(filename)).rejects.toMatchObject({
      lineNumber: 2,
      codePoint: "U+0000",
      message: expect.not.stringContaining("secret"),
    });
  });

  it("accepts a tab, a lone trailing CR, and CRLF terminators", async () => {
    const filename = await writeTodoFile(
      "allowed.txt",
      "column\tseparated\ntrailing\r\nlast\r",
    );

    const todos = await readTodosFromFile(filename);

    expect(todos).toHaveLength(3);
    expect(todos[0].text).toBe("column\tseparated");
    expect(todos[1].text).toBe("trailing");
    expect(todos[2].text).toBe("last");
  });

  it("keeps CRLF file bytes unchanged across a read/write round-trip", async () => {
    const original = "alpha\r\nbeta due:2020-01-01\r\n";
    const filename = await writeTodoFile("crlf.txt", original);

    const todos = await readTodosFromFile(filename);
    await writeTodosToFile(todos, filename);

    expect(await readFile(filename, "utf8")).toBe(original);
  });
});

describe("list_todos error mapping", () => {
  let server: ReturnType<typeof createTodoMcpServer>;
  let client: Client;

  async function connect(filename: string): Promise<void> {
    server = createTodoMcpServer(new LocalFileBackend(filename));
    const [clientTransport, serverTransport] = InMemoryTransport
      .createLinkedPair();
    client = new Client({ name: "read-path-test", version: "1.0.0" });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
  }

  afterEach(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });

  it("returns structured LIMIT_EXCEEDED for an over-cap file", async () => {
    vi.stubEnv("TODOTXT_MCP_MAX_READ_TODOS", "2");
    const filename = await writeTodoFile("too-many.txt", "one\ntwo\nthree\n");
    await connect(filename);

    const result = await client.callTool({
      name: "list_todos",
      arguments: {},
    });

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "LIMIT_EXCEEDED",
          details: { maxReadTodos: 2, actualCount: 3 },
        },
      },
    });
  });

  it("returns structured BACKEND_ERROR for unsafe content", async () => {
    const filename = await writeTodoFile("unsafe.txt", "safe\nbad\u0000line\n");
    await connect(filename);

    const result = await client.callTool({
      name: "list_todos",
      arguments: {},
    });

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "BACKEND_ERROR",
          details: { lineNumber: 2, codePoint: "U+0000" },
        },
      },
    });
    const text = (result as { content: Array<{ text?: string }> }).content
      .map((item) => item.text ?? "")
      .join("\n");
    expect(text).not.toContain("bad");
    expect(text).not.toContain("\u0000");
  });
});

describe("manual low-memory check", () => {
  it("rejects a 1 MB / 500,000-line file under a 128 MB heap", async () => {
    const filename = await writeTodoFile("low-memory.txt", "a\n".repeat(500_000));
    const script = `
      import { pathToFileURL } from "node:url";
      const moduleUrl = pathToFileURL(process.env.TODO_HELPER_MODULE).href;
      const { readTodosFromFile } = await import(moduleUrl);
      try {
        await readTodosFromFile(process.env.TODO_FILE);
        console.log("ACCEPTED");
        process.exit(1);
      } catch (error) {
        console.log(error.name);
        process.exit(error.name === "ReadTodoCountLimitError" ? 0 : 2);
      }
    `;

    const child = spawnSync(
      process.execPath,
      ["--max-old-space-size=128", "--input-type=module", "--eval", script],
      {
        env: {
          ...process.env,
          TODO_FILE: filename,
          TODO_HELPER_MODULE: join(
            import.meta.dirname,
            "..",
            "logic",
            "todo-file-helpers.ts",
          ),
          // Do not inherit a parent heap flag; the child sets its own.
          NODE_OPTIONS: "",
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );

    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout.trim()).toBe("ReadTodoCountLimitError");
  });
});

describe("WebDAV read path", () => {
  it("applies the line-count cap to a WebDAV body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("a\n".repeat(50_001), {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        })
      ),
    );

    await expect(
      new WebDavBackend("https://dav.example.com/todo.txt").load(),
    ).rejects.toBeInstanceOf(ReadTodoCountLimitError);
  });

  it("rejects unsafe content from a WebDAV body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("safe\nbad\u0000line\n", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        })
      ),
    );

    await expect(
      new WebDavBackend("https://dav.example.com/todo.txt").load(),
    ).rejects.toBeInstanceOf(UnsafeTodoFileContentError);
  });
});

describe("validator stays pure", () => {
  it("returns raw lines without constructing Todo objects", () => {
    const lines = validateTodoFileContent("first\n\nsecond\n", LIMITS);

    expect(lines).toEqual(["first", "", "second", ""]);
    expect(lines.every((line) => typeof line === "string")).toBe(true);
  });
});
