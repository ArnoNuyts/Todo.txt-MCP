import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSecurityPosture,
  logSecurityPosture,
  type SecurityPostureInput,
} from "../logic/security-posture.ts";
import { createLogger } from "../logic/logging.ts";

const directories: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
    }),
  );
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

function posture(
  overrides: Partial<SecurityPostureInput> = {},
): SecurityPostureInput {
  return {
    host: "127.0.0.1",
    port: 3000,
    trustProxy: "loopback",
    metrics: { enabled: true, tokenSource: "mcp" },
    tokenSource: "file",
    tokenCount: 1,
    readOnly: false,
    backend: "local",
    allowWeakToken: false,
    ...overrides,
  };
}

describe("security posture record", () => {
  it("keeps loopback defaults quiet", () => {
    const record = buildSecurityPosture(posture());

    expect(record.warnings).toEqual([]);
    expect(record).toMatchObject({
      host: "127.0.0.1",
      port: 3000,
      trustProxy: "loopback",
      metrics: { enabled: true, tokenSource: "mcp" },
      tokenSource: "file",
      tokenCount: 1,
      readOnly: false,
      backend: "local",
    });
  });

  it("warns for a risky non-loopback matrix", () => {
    const record = buildSecurityPosture(posture({
      host: "0.0.0.0",
      trustProxy: true,
      metrics: { enabled: true, tokenSource: "none" },
      tokenSource: "env",
      allowWeakToken: true,
      readOnlyValue: "on",
      proxyWarnings: ["proxy_trust_wildcard"],
    }));

    expect(record.warnings).toEqual([
      "non_loopback_bind",
      "metrics_enabled_non_loopback",
      "weak_token_override",
      "proxy_trust_wildcard",
      "read_only_value_unrecognized",
      "env_token_non_loopback",
    ]);
  });

  it("does not warn about metrics when it is disabled", () => {
    const record = buildSecurityPosture(posture({
      host: "203.0.113.9",
      metrics: { enabled: false, tokenSource: "none" },
      tokenSource: "file",
      trustProxy: "loopback",
    }));

    expect(record.warnings).toContain("non_loopback_bind");
    expect(record.warnings).not.toContain("metrics_enabled_non_loopback");
  });

  it("accepts recognized read-only spellings", () => {
    for (const value of ["1", "true", "yes", "0", "false", "no", ""]) {
      const record = buildSecurityPosture(posture({ readOnlyValue: value }));
      expect(record.warnings).not.toContain("read_only_value_unrecognized");
    }
    expect(
      buildSecurityPosture(posture({ readOnlyValue: "on" })).warnings,
    ).toContain("read_only_value_unrecognized");
  });

  it("emits one posture record and only new warning records", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const logger = createLogger({
      level: "debug",
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    logSecurityPosture(logger, posture({
      host: "0.0.0.0",
      metrics: { enabled: true, tokenSource: "none" },
      tokenSource: "env",
      allowWeakToken: true,
      proxyWarnings: ["proxy_trust_missing"],
    }));

    const info = stdout.map((line) => JSON.parse(line) as Record<string, unknown>);
    const postureRecords = info.filter((record) =>
      record.msg === "security_posture"
    );
    expect(postureRecords).toHaveLength(1);
    expect(postureRecords[0]).toMatchObject({
      host: "0.0.0.0",
      tokenSource: "env",
      warnings: expect.arrayContaining([
        "non_loopback_bind",
        "metrics_enabled_non_loopback",
        "weak_token_override",
        "proxy_trust_missing",
        "env_token_non_loopback",
      ]),
    });

    const warns = stderr.map((line) => JSON.parse(line) as {
      msg?: string;
      code?: string;
      message?: string;
    });
    const warningRecords = warns.filter((record) =>
      record.msg === "security_posture_warning"
    );
    expect(warningRecords.map((record) => record.code).sort()).toEqual([
      "env_token_non_loopback",
      "metrics_enabled_non_loopback",
      "non_loopback_bind",
    ]);
    // Weak-token and proxy messages already have their own dedicated records.
    expect(warningRecords.map((record) => record.code)).not.toContain(
      "weak_token_override",
    );
    expect(warningRecords.map((record) => record.code)).not.toContain(
      "proxy_trust_missing",
    );
  });
});

describe("startup posture integration", () => {
  async function tempDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "todo-txt-mcp-posture-"));
    directories.push(directory);
    return directory;
  }

  it("emits the posture line once and never includes the token", async () => {
    const directory = await tempDirectory();
    await writeFile(join(directory, "todo.txt"), "task\n");
    const token = "posture-token-aaaaaaaaaaaaaaaaaaaaaaaa";

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      MCP_AUTH_TOKEN: token,
      TODOTXT_MCP_LOCAL_FILENAME: "todo.txt",
      MCP_LOG_LEVEL: "info",
    };
    delete env.MCP_AUTH_TOKEN_FILE;
    delete env.MCP_AUTH_TOKENS;
    delete env.MCP_METRICS_TOKEN;

    const child = spawn(process.execPath, [join(process.cwd(), "server.ts")], {
      cwd: directory,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const deadline = Date.now() + 10_000;
    while (
      !stdout.includes("Server running") ||
      !`${stdout}\n${stderr}`.includes('"msg":"security_posture"')
    ) {
      if (child.exitCode !== null || Date.now() > deadline) {
        throw new Error(`server did not start:\n${stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const records = `${stdout}\n${stderr}`
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
    const postureRecords = records.filter((record) =>
      record.msg === "security_posture"
    );
    expect(postureRecords).toHaveLength(1);
    expect(postureRecords[0]).toMatchObject({
      host: "127.0.0.1",
      tokenSource: "env",
      tokenCount: 1,
      readOnly: false,
      backend: "local",
    });
    expect(`${stdout}\n${stderr}`).not.toContain(token);
  }, 15_000);

  it("fails startup for an invalid MCP_METRICS_ENABLED value", async () => {
    const directory = await tempDirectory();
    await writeFile(join(directory, "todo.txt"), "task\n");

    const child = spawn(process.execPath, [join(process.cwd(), "server.ts")], {
      cwd: directory,
      env: {
        ...process.env,
        PORT: "0",
        HOST: "127.0.0.1",
        MCP_AUTH_TOKEN: "startup-token-aaaaaaaaaaaaaaaaaaaaaaaa",
        MCP_METRICS_ENABLED: "on",
        TODOTXT_MCP_LOCAL_FILENAME: "todo.txt",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const [code] = await once(child, "exit") as [number | null];
    expect(code).toBe(1);
    expect(stderr).toContain("MCP_METRICS_ENABLED");
    expect(stdout).not.toContain("Server running");
  }, 15_000);
});
