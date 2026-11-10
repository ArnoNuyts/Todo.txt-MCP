import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

interface RunningServer {
  child: ChildProcess;
  port: number;
  stdout: () => string;
  stderr: () => string;
  logs: () => string;
}

const directories: string[] = [];
const servers: RunningServer[] = [];

function strongToken(): string {
  return randomBytes(32).toString("hex");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "todo-txt-mcp-reload-"));
  directories.push(directory);
  return directory;
}

async function writeTokens(path: string, tokens: string[]): Promise<void> {
  await writeFile(path, `${tokens.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
}

async function startServer(directory: string, tokenFile: string): Promise<RunningServer> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: "0",
    HOST: "127.0.0.1",
    MCP_AUTH_TOKEN_FILE: tokenFile,
    TODOTXT_MCP_LOCAL_FILENAME: "todo.txt",
    MCP_LOG_LEVEL: "info",
  };
  delete env.MCP_AUTH_TOKEN;
  delete env.MCP_AUTH_TOKENS;
  delete env.MCP_ALLOW_WEAK_TOKEN;
  delete env.TRUST_PROXY;

  const child = spawn(process.execPath, [join(process.cwd(), "server.ts")], {
    cwd: directory,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const port = await new Promise<number>((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    const timer = setInterval(() => {
      const match = /Server running on http:\/\/localhost:(\d+)/.exec(stdout);
      if (match !== null) {
        clearInterval(timer);
        resolve(Number(match[1]));
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error(`server did not start:\n${stderr}`));
      }
    }, 10);
    child.once("error", (error) => {
      clearInterval(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearInterval(timer);
      reject(new Error(`server exited with ${code}:\n${stderr}`));
    });
  });

  const running: RunningServer = {
    child,
    port,
    stdout: () => stdout,
    stderr: () => stderr,
    logs: () => `${stdout}\n${stderr}`,
  };
  servers.push(running);
  return running;
}

async function stopServer(server: RunningServer): Promise<void> {
  const index = servers.indexOf(server);
  if (index !== -1) {
    servers.splice(index, 1);
  }
  if (server.child.exitCode !== null || server.child.signalCode !== null) {
    return;
  }
  server.child.kill("SIGTERM");
  await Promise.race([
    once(server.child, "exit"),
    delay(5_000).then(() => server.child.kill("SIGKILL")),
  ]);
}

async function tokenStatus(port: number, token: string): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "token-reload-test", version: "1.0.0" },
      },
    }),
  });
  await response.body?.cancel();
  return response.status;
}

async function waitForStatus(
  port: number,
  token: string,
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 8_000;
  let status = 0;
  while (Date.now() < deadline) {
    status = await tokenStatus(port, token);
    if (status === expected) {
      return;
    }
    await delay(25);
  }
  throw new Error(`expected ${expected}, last status was ${status}`);
}

async function waitForLog(
  server: RunningServer,
  predicate: (record: Record<string, unknown>) => boolean,
): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const records = server.logs()
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
    if (records.some(predicate)) {
      return;
    }
    await delay(25);
  }
  throw new Error(`expected log was not emitted:\n${server.logs()}`);
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => stopServer(server)));
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("SIGHUP token file reload", () => {
  it("adds a token without a restart", async () => {
    const directory = await tempDirectory();
    const tokenFile = join(directory, "tokens");
    const first = strongToken();
    const added = strongToken();
    await writeTokens(tokenFile, [first]);

    const server = await startServer(directory, tokenFile);
    expect(await tokenStatus(server.port, first)).toBe(200);
    expect(await tokenStatus(server.port, added)).toBe(401);

    await writeTokens(tokenFile, [first, added]);
    server.child.kill("SIGHUP");

    await waitForStatus(server.port, added, 200);
    expect(await tokenStatus(server.port, first)).toBe(200);
    await waitForLog(
      server,
      (record) =>
        record.msg === "auth_tokens_reloaded" && record.count === 2,
    );

    expect(server.logs()).not.toContain(first);
    expect(server.logs()).not.toContain(added);
  });

  it("removes a token without a restart", async () => {
    const directory = await tempDirectory();
    const tokenFile = join(directory, "tokens");
    const removed = strongToken();
    const kept = strongToken();
    await writeTokens(tokenFile, [removed, kept]);

    const server = await startServer(directory, tokenFile);
    expect(await tokenStatus(server.port, removed)).toBe(200);
    expect(await tokenStatus(server.port, kept)).toBe(200);

    await writeTokens(tokenFile, [kept]);
    server.child.kill("SIGHUP");

    await waitForStatus(server.port, removed, 401);
    expect(await tokenStatus(server.port, kept)).toBe(200);
    await waitForLog(
      server,
      (record) =>
        record.msg === "auth_tokens_reloaded" && record.count === 1,
    );

    expect(server.logs()).not.toContain(removed);
    expect(server.logs()).not.toContain(kept);
  });

  it("keeps the old tokens when the reloaded file is empty or invalid", async () => {
    const directory = await tempDirectory();
    const tokenFile = join(directory, "tokens");
    const kept = strongToken();
    await writeTokens(tokenFile, [kept]);

    const server = await startServer(directory, tokenFile);
    expect(await tokenStatus(server.port, kept)).toBe(200);

    await writeFile(tokenFile, "   \n", "utf8");
    server.child.kill("SIGHUP");

    await waitForLog(server, (record) =>
      record.msg === "auth_tokens_reload_failed");
    expect(await tokenStatus(server.port, kept)).toBe(200);
    expect(server.logs()).not.toContain(kept);
  });
});
