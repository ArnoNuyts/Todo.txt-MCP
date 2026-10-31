import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("startup auth guard", () => {
  it("exits without listening when no token is configured", async () => {
    const directory = await mkdtemp(join(tmpdir(), "todo-txt-mcp-startup-"));
    directories.push(directory);

    const child = spawn(process.execPath, [join(process.cwd(), "server.ts")], {
      cwd: directory,
      env: {
        ...process.env,
        PORT: "0",
        MCP_AUTH_TOKEN: "",
        MCP_AUTH_TOKENS: "",
        MCP_AUTH_TOKEN_FILE: "",
        TODOTXT_MCP_LOCAL_FILENAME: "todo.txt",
      },
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

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("server did not exit without an auth token"));
      }, 10_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Refusing to start: no MCP auth token");
    expect(stdout).not.toContain("Server running");
  }, 15_000);
});
