import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  removeDirectory,
  type RunningServer,
  startServer as spawnServer,
  stopServer,
  temporaryDirectory,
  tokenStatus,
  waitForLog,
  waitForStatus,
} from "./helpers/server-process.ts";

const directories: string[] = [];
const servers: RunningServer[] = [];

function strongToken(): string {
  return randomBytes(32).toString("hex");
}

async function tempDirectory(): Promise<string> {
  const directory = await temporaryDirectory("todo-txt-mcp-reload-");
  directories.push(directory);
  return directory;
}

async function writeTokens(path: string, tokens: string[]): Promise<void> {
  await writeFile(path, `${tokens.join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function startServer(
  directory: string,
  tokenFile: string,
): Promise<RunningServer> {
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

  const server = await spawnServer({ cwd: directory, env });
  servers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => stopServer(server)));
  await Promise.all(
    directories.splice(0).map((directory) => removeDirectory(directory)),
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
