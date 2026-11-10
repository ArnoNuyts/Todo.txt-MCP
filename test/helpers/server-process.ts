import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A spawned `server.ts` process with captured output. */
export interface RunningServer {
  child: ChildProcess;
  port: number;
  stdout: () => string;
  stderr: () => string;
  logs: () => string;
}

export interface SpawnServerOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Wait for the `Server running` line and parse the port. Default true. */
  waitForReady?: boolean;
  timeoutMs?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function temporaryDirectory(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

export async function removeDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

function collect(child: ChildProcess) {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  return {
    stdout: () => stdout,
    stderr: () => stderr,
    logs: () => `${stdout}\n${stderr}`,
  };
}

async function waitForPort(
  child: ChildProcess,
  output: () => string,
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  return await new Promise<number>((resolve, reject) => {
    const timer = setInterval(() => {
      const match = /Server running on http:\/\/localhost:(\d+)/.exec(
        output(),
      );
      if (match !== null) {
        clearInterval(timer);
        resolve(Number(match[1]));
        return;
      }
      if (child.exitCode !== null || Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error(`server did not start:\n${output()}`));
      }
    }, 10);
    child.once("error", (error) => {
      clearInterval(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearInterval(timer);
      reject(new Error(`server exited with ${code}:\n${output()}`));
    });
  });
}

/** Starts `server.ts` from the repo root with a temp cwd and environment. */
export async function startServer(
  options: SpawnServerOptions,
): Promise<RunningServer> {
  const child = spawn(process.execPath, [join(process.cwd(), "server.ts")], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = collect(child);
  const port = options.waitForReady === false
    ? 0
    : await waitForPort(child, output.logs, options.timeoutMs ?? 10_000);
  return { child, port, ...output };
}

export async function stopServer(server: RunningServer): Promise<void> {
  if (server.child.exitCode !== null || server.child.signalCode !== null) {
    return;
  }
  server.child.kill("SIGTERM");
  await Promise.race([
    once(server.child, "exit"),
    delay(5_000).then(() => server.child.kill("SIGKILL")),
  ]);
}

export async function waitForExit(
  child: ChildProcess,
): Promise<number | null> {
  if (child.exitCode !== null) {
    return child.exitCode;
  }
  const [code] = await once(child, "exit") as [number | null];
  return code;
}

export function parseLogRecords(
  logs: string,
): Array<Record<string, unknown>> {
  return logs
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

export async function waitForLog(
  server: RunningServer,
  predicate: (record: Record<string, unknown>) => boolean,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (parseLogRecords(server.logs()).some(predicate)) {
      return;
    }
    await delay(25);
  }
  throw new Error(`expected log was not emitted:\n${server.logs()}`);
}

export async function tokenStatus(
  port: number,
  token: string,
): Promise<number> {
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
        clientInfo: { name: "server-process-test", version: "1.0.0" },
      },
    }),
  });
  await response.body?.cancel();
  return response.status;
}

export async function waitForStatus(
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
