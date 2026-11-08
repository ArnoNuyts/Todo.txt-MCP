import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTransportMode } from "../logic/transport.ts";
import { createLogger } from "../logic/logging.ts";

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: {
    serverInfo?: { name?: string };
    tools?: Array<{ name: string }>;
    content?: Array<{ type: string; text?: string }>;
  };
  error?: { code: number; message: string };
}

const directories: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit").catch(() => {});
    }
  }
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("transport mode selection", () => {
  it("defaults to HTTP", () => {
    expect(resolveTransportMode([], {})).toBe("http");
    expect(resolveTransportMode([], { MCP_TRANSPORT: "" })).toBe("http");
    expect(resolveTransportMode([], { MCP_TRANSPORT: "http" })).toBe("http");
  });

  it("enables stdio with --stdio or MCP_TRANSPORT=stdio", () => {
    expect(resolveTransportMode(["--stdio"], {})).toBe("stdio");
    expect(resolveTransportMode([], { MCP_TRANSPORT: "stdio" })).toBe("stdio");
    expect(resolveTransportMode([], { MCP_TRANSPORT: " STDIO " })).toBe(
      "stdio",
    );
  });

  it("lets the explicit flag win over the environment", () => {
    expect(
      resolveTransportMode(["--stdio"], { MCP_TRANSPORT: "http" }),
    ).toBe("stdio");
  });

  it("rejects unknown transports instead of silently falling back", () => {
    expect(() => resolveTransportMode([], { MCP_TRANSPORT: "sse" }))
      .toThrow(/MCP_TRANSPORT/);
  });
});

describe("stdio logging", () => {
  it("keeps stdout clean by routing info logs to stderr", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const logger = createLogger({
      level: "debug",
      stderrOnly: true,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    logger.debug("starting");
    logger.info("ready");
    logger.warn("careful");

    expect(stdout).toEqual([]);
    expect(stderr).toHaveLength(3);
  });
});

class StdioClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: JsonRpcMessage) => void; reject: (error: Error) => void }
  >();
  private readonly stdoutLines: string[] = [];
  private readonly stderrChunks: string[] = [];
  readonly child: ChildProcessWithoutNullStreams;

  constructor(cwd: string, args: string[], env: NodeJS.ProcessEnv) {
    this.child = spawn(
      process.execPath,
      [join(process.cwd(), "server.ts"), ...args],
      {
        cwd,
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    children.push(this.child);

    createInterface({ input: this.child.stdout }).on("line", (line) => {
      this.stdoutLines.push(line);
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        return;
      }
      if (typeof message.id !== "number") {
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      pending.resolve(message);
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrChunks.push(chunk.toString("utf8"));
    });
  }

  get stdout(): string[] {
    return this.stdoutLines;
  }

  get stderr(): string {
    return this.stderrChunks.join("");
  }

  async request(
    method: string,
    params?: unknown,
    timeoutMs = 10_000,
  ): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    const message: JsonRpcMessage = { jsonrpc: "2.0", id, method, params };
    const response = new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject,
      });
    });
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    return await response;
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
    );
  }

  async close(): Promise<number | null> {
    this.child.stdin.end();
    const [code] = await once(this.child, "exit");
    return code as number | null;
  }
}

async function startStdio(
  options: {
    env?: NodeJS.ProcessEnv;
    args?: string[];
    todoContent?: string;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "todo-txt-mcp-stdio-"));
  directories.push(directory);
  const filename = join(directory, "todo.txt");
  if (options.todoContent !== undefined) {
    await writeFile(filename, options.todoContent, "utf8");
  }

  const client = new StdioClient(
    directory,
    options.args ?? ["--stdio"],
    {
      TODOTXT_MCP_BACKEND: "local",
      TODOTXT_MCP_LOCAL_FILENAME: filename,
      MCP_AUTH_TOKEN: "",
      MCP_AUTH_TOKENS: "",
      MCP_AUTH_TOKEN_FILE: "",
      ...options.env,
    },
  );

  const init = await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "stdio-test", version: "1.0.0" },
  });
  expect(init.error).toBeUndefined();
  client.notify("notifications/initialized");
  return { client, directory, filename, init };
}

describe("stdio transport", () => {
  it("serves MCP over stdin/stdout without an auth token", async () => {
    const { client, filename, init } = await startStdio({
      todoContent: "(A) existing task\n",
    });

    expect(init.result?.serverInfo?.name).toBe("todo.txt-mcp");

    const tools = await client.request("tools/list");
    expect(tools.error).toBeUndefined();
    expect(tools.result?.tools?.map((tool) => tool.name).sort()).toEqual([
      "add_todos",
      "delete_todos",
      "list_todos",
      "update_todos",
    ]);

    const added = await client.request("tools/call", {
      name: "add_todos",
      arguments: { todos: ["buy milk @shop"] },
    });
    expect(added.error).toBeUndefined();
    const addedText = added.result?.content?.[0]?.text ?? "";
    expect(addedText).toMatch(/^[A-Za-z0-9_-]{11} buy milk @shop$/m);

    const listed = await client.request("tools/call", {
      name: "list_todos",
      arguments: {},
    });
    expect(listed.error).toBeUndefined();
    const listedText = listed.result?.content?.[0]?.text ?? "";
    expect(listedText).toContain("existing task");
    expect(listedText).toContain("buy milk @shop");

    const exitCode = await client.close();
    expect(exitCode).toBe(0);

    const stored = await readFile(filename, "utf8");
    expect(stored).toContain("buy milk @shop");

    // stdout is the protocol channel: every line must be a JSON-RPC message.
    for (const line of client.stdout) {
      const parsed = JSON.parse(line) as JsonRpcMessage;
      expect(parsed.jsonrpc).toBe("2.0");
    }
  }, 20_000);

  it("honours read-only mode", async () => {
    const { client } = await startStdio({ env: { MCP_READ_ONLY: "1" } });

    const tools = await client.request("tools/list");
    expect(tools.result?.tools?.map((tool) => tool.name)).toEqual([
      "list_todos",
    ]);

    expect(await client.close()).toBe(0);
  }, 20_000);

  it("enables stdio through MCP_TRANSPORT without the flag", async () => {
    const { client } = await startStdio({
      args: [],
      env: { MCP_TRANSPORT: "stdio" },
    });

    const tools = await client.request("tools/list");
    expect(tools.result?.tools?.length).toBe(4);
    expect(await client.close()).toBe(0);
  }, 20_000);

  it("exits and releases the advisory lock when stdin closes", async () => {
    const { client, filename } = await startStdio({
      todoContent: "cleanup task\n",
    });

    await client.request("tools/call", {
      name: "add_todos",
      arguments: { todos: ["second task"] },
    });

    expect(await client.close()).toBe(0);
    await expect(readFile(`${filename}.lock`, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 20_000);

  it("shuts down cleanly on SIGTERM", async () => {
    const { client } = await startStdio();

    client.child.kill("SIGTERM");
    const [code] = await once(client.child, "exit");
    expect(code).toBe(0);
  }, 20_000);

  it("fails fast on an invalid MCP_TRANSPORT", async () => {
    const directory = await mkdtemp(join(tmpdir(), "todo-txt-mcp-stdio-"));
    directories.push(directory);
    const child = spawn(process.execPath, [join(process.cwd(), "server.ts")], {
      cwd: directory,
      env: {
        ...process.env,
        MCP_TRANSPORT: "sse",
        MCP_AUTH_TOKEN: "",
        MCP_AUTH_TOKENS: "",
        MCP_AUTH_TOKEN_FILE: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const [code] = await once(child, "exit");

    expect(code).toBe(1);
    expect(stderr).toContain("Invalid MCP_TRANSPORT");
  }, 20_000);
});
