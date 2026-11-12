import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  removeDirectory,
  type RunningServer,
  startServer,
  stopServer,
  temporaryDirectory,
  waitForExit,
} from "./helpers/server-process.ts";

const directories: string[] = [];
const servers: RunningServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => stopServer(server)));
  await Promise.all(
    directories.splice(0).map((directory) => removeDirectory(directory)),
  );
});

async function tempDirectory(): Promise<string> {
  const directory = await temporaryDirectory("todo-txt-mcp-startup-security-");
  directories.push(directory);
  await writeFile(join(directory, "todo.txt"), "task\n");
  return directory;
}

function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: "0",
    HOST: "127.0.0.1",
    MCP_AUTH_TOKEN: randomBytes(32).toString("hex"),
    TODOTXT_MCP_LOCAL_FILENAME: "todo.txt",
  };
  delete env.MCP_AUTH_TOKENS;
  delete env.MCP_AUTH_TOKEN_FILE;
  delete env.MCP_ALLOW_WEAK_TOKEN;
  delete env.TRUST_PROXY;
  delete env.MCP_READ_ONLY;
  delete env.MCP_READYZ_RATE_LIMIT_PER_MIN;
  return env;
}

async function expectStartupFailure(
  env: NodeJS.ProcessEnv,
  expectedMessage: RegExp,
): Promise<void> {
  const server = await startServer({
    cwd: await tempDirectory(),
    env,
    waitForReady: false,
  });
  servers.push(server);

  expect(await waitForExit(server.child)).toBe(1);
  expect(server.stderr()).toMatch(expectedMessage);
  expect(server.stdout()).not.toContain("Server running");
}

describe("startup proxy posture", () => {
  it("refuses wildcard TRUST_PROXY on a non-loopback bind", async () => {
    for (const trustProxy of ["true", "0.0.0.0/0", "::/0", "10.0.0.0/8,0.0.0.0/0"]) {
      await expectStartupFailure(
        { ...baseEnv(), HOST: "0.0.0.0", TRUST_PROXY: trustProxy },
        /TRUST_PROXY trusts every hop/,
      );
    }
  }, 30_000);

  it("still starts with loopback defaults and exact proxy values", async () => {
    const loopback = await startServer({
      cwd: await tempDirectory(),
      env: baseEnv(),
    });
    servers.push(loopback);

    const exactProxyValues = ["loopback", "203.0.113.5", "10.0.0.0/8"];
    for (const trustProxy of exactProxyValues) {
      const server = await startServer({
        cwd: await tempDirectory(),
        env: { ...baseEnv(), HOST: "0.0.0.0", TRUST_PROXY: trustProxy },
      });
      servers.push(server);
    }
  }, 30_000);
});

describe("startup readiness limit", () => {
  it("rejects an invalid MCP_READYZ_RATE_LIMIT_PER_MIN", async () => {
    for (const value of ["-1", "many", "1.5"]) {
      await expectStartupFailure(
        { ...baseEnv(), MCP_READYZ_RATE_LIMIT_PER_MIN: value },
        /MCP_READYZ_RATE_LIMIT_PER_MIN/,
      );
    }
  }, 30_000);
});

describe("startup read-only mode", () => {
  it("rejects an unrecognized MCP_READ_ONLY value", async () => {
    await expectStartupFailure(
      { ...baseEnv(), MCP_READ_ONLY: "on" },
      /Invalid MCP_READ_ONLY/,
    );
  }, 15_000);
});
