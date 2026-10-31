import { describe, expect, it } from "vitest";
import {
  createLogger,
  normalizeRequestId,
  REQUEST_ID_PATTERN,
  resolveLogLevel,
} from "../logic/logging.ts";

describe("structured logging", () => {
  it("resolves the configured level and falls back to info", () => {
    expect(resolveLogLevel({})).toBe("info");
    expect(resolveLogLevel({ MCP_LOG_LEVEL: "debug" })).toBe("debug");
    expect(resolveLogLevel({ MCP_LOG_LEVEL: " WARN " })).toBe("warn");
    expect(resolveLogLevel({ MCP_LOG_LEVEL: "error" })).toBe("error");
    expect(resolveLogLevel({ MCP_LOG_LEVEL: "verbose" })).toBe("info");
  });

  it("writes one JSON line per record to the level-appropriate sink", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const logger = createLogger({
      level: "info",
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      now: () => new Date("2026-10-31T12:00:00.000Z"),
    });

    logger.debug("hidden", { secret: "never" });
    logger.info("request", { requestId: "abc" });
    logger.warn("rate_limited", { ip: "127.0.0.1" });
    logger.error("boom", { message: "failed" });

    expect(stdout).toHaveLength(1);
    expect(stderr).toHaveLength(2);
    expect(JSON.parse(stdout[0])).toEqual({
      requestId: "abc",
      ts: "2026-10-31T12:00:00.000Z",
      level: "info",
      msg: "request",
    });
    expect(JSON.parse(stderr[0])).toMatchObject({
      level: "warn",
      msg: "rate_limited",
      ip: "127.0.0.1",
    });
    expect(JSON.parse(stderr[1])).toMatchObject({
      level: "error",
      msg: "boom",
    });
  });
});

describe("request IDs", () => {
  it("accepts bounded safe IDs and ignores everything else", () => {
    expect(REQUEST_ID_PATTERN.test("abc-123_ok.test")).toBe(true);
    expect(normalizeRequestId("abc-123_ok.test")).toBe("abc-123_ok.test");
    expect(normalizeRequestId(["array-id"])).toBe("array-id");
    expect(normalizeRequestId("bad id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(normalizeRequestId("x".repeat(129))).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(normalizeRequestId(undefined)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
