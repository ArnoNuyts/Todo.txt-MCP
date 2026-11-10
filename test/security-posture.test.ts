import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSecurityPosture,
  logSecurityPosture,
  type SecurityPostureInput,
} from "../logic/security-posture.ts";
import { createLogger } from "../logic/logging.ts";
import {
  parseLogRecords,
  removeDirectory,
  type RunningServer,
  startServer,
  stopServer,
  temporaryDirectory,
  waitForExit,
  waitForLog,
} from "./helpers/server-process.ts";

const directories: string[] = [];
const servers: RunningServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => stopServer(server)));
  await Promise.all(
    directories.splice(0).map((directory) => removeDirectory(directory)),
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

    expect(record.warnings).toHaveLength(6);
    expect(record.warnings).toEqual(expect.arrayContaining([
      "non_loopback_bind",
      "metrics_enabled_non_loopback",
      "weak_token_override",
      "proxy_trust_wildcard",
      "read_only_value_unrecognized",
      "env_token_non_loopback",
    ]));
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
    const directory = await temporaryDirectory("todo-txt-mcp-posture-");
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

    const server = await startServer({ cwd: directory, env });
    servers.push(server);
    await waitForLog(server, (record) => record.msg === "security_posture");

    const postureRecords = parseLogRecords(server.logs()).filter((record) =>
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
    expect(server.logs()).not.toContain(token);
  }, 15_000);

  it("fails startup for an invalid MCP_METRICS_ENABLED value", async () => {
    const directory = await tempDirectory();
    await writeFile(join(directory, "todo.txt"), "task\n");

    const server = await startServer({
      cwd: directory,
      env: {
        ...process.env,
        PORT: "0",
        HOST: "127.0.0.1",
        MCP_AUTH_TOKEN: "startup-token-aaaaaaaaaaaaaaaaaaaaaaaa",
        MCP_METRICS_ENABLED: "on",
        TODOTXT_MCP_LOCAL_FILENAME: "todo.txt",
      },
      waitForReady: false,
    });
    servers.push(server);

    expect(await waitForExit(server.child)).toBe(1);
    expect(server.stderr()).toContain("MCP_METRICS_ENABLED");
    expect(server.stdout()).not.toContain("Server running");
  }, 15_000);
});
