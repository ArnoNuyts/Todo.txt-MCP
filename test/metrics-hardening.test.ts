import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type CreateAppOptions } from "../server.ts";
import {
  assertStrongMetricsToken,
  DEFAULT_METRICS_RATE_LIMIT_PER_MIN,
  parseMetricsToken,
  resolveMetricsConfig,
  resolveMetricsEnabled,
} from "../logic/metrics-config.ts";
import { MockBackend } from "./helpers/mock-backend.ts";

interface RpcError {
  error?: { code?: number; message?: string };
}

describe("metrics endpoint hardening", () => {
  let httpServer: Server;
  let backend: MockBackend;
  let baseUrl: string;

  async function startApp(options: CreateAppOptions = {}) {
    httpServer = createApp(backend, options).listen(0, "127.0.0.1");
    await once(httpServer, "listening");
    const address = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async function stopApp() {
    if (!httpServer.listening) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => error ? reject(error) : resolve());
    });
  }

  async function restartApp(options: CreateAppOptions = {}) {
    await stopApp();
    await startApp(options);
  }

  function initializeBody(): string {
    return JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "metrics-test", version: "1.0.0" },
      },
    });
  }

  async function postMcp(token: string): Promise<Response> {
    return await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: initializeBody(),
    });
  }

  async function scrape(token?: string): Promise<Response> {
    return await fetch(`${baseUrl}/metrics`, {
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });
  }

  beforeEach(async () => {
    backend = new MockBackend();
    await startApp();
  });

  afterEach(async () => {
    await stopApp();
    vi.unstubAllEnvs();
  });

  it("enables metrics by default on a loopback bind", async () => {
    await restartApp({ metrics: { host: "127.0.0.1" } });

    const response = await scrape();
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("todo_mcp_requests_total");
  });

  it("disables metrics by default on a non-loopback bind", async () => {
    await restartApp({ metrics: { host: "0.0.0.0" } });

    const response = await scrape();
    expect(response.status).toBe(404);
    const text = await response.text();
    expect(text).not.toContain("todo_mcp_requests_total");
  });

  it("honors an explicit opt-in on a non-loopback bind", async () => {
    await restartApp({ metrics: { host: "0.0.0.0", enabled: true } });

    const response = await scrape();
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("todo_mcp_requests_total");
  });

  it("honors an explicit opt-out even on loopback", async () => {
    await restartApp({ metrics: { host: "127.0.0.1", enabled: false } });

    const response = await scrape();
    expect(response.status).toBe(404);
  });

  it("returns 404 without auth when metrics is disabled", async () => {
    await restartApp({
      authToken: "metrics-disabled-token-aaaaaaaaaaaaaa",
      metrics: { enabled: false },
    });

    const response = await scrape();
    expect(response.status).toBe(404);
    expect(response.headers.get("www-authenticate")).toBeNull();
  });

  it("isolates a separate metrics token from the /mcp token", async () => {
    const mcpToken = "mcp-token-aaaaaaaaaaaaaaaaaaaaaaaa";
    const metricsToken = "metrics-token-bbbbbbbbbbbbbbbbbbbbbb";
    await restartApp({
      authToken: mcpToken,
      metrics: { enabled: true, token: metricsToken },
    });

    expect((await scrape(mcpToken)).status).toBe(401);
    expect((await scrape(metricsToken)).status).toBe(200);

    expect((await postMcp(metricsToken)).status).toBe(401);
    expect((await postMcp(mcpToken)).status).toBe(200);
  });

  it("requires the /mcp token on metrics when no separate token is set", async () => {
    const token = "shared-token-aaaaaaaaaaaaaaaaaaaaaaaa";
    await restartApp({ authToken: token, metrics: { enabled: true } });

    expect((await scrape()).status).toBe(401);
    expect((await scrape("wrong-token")).status).toBe(401);
    expect((await scrape(token)).status).toBe(200);
  });

  it("rate limits the 61st scrape without touching /mcp", async () => {
    const token = "rate-limit-token-aaaaaaaaaaaaaaaaaaaa";
    await restartApp({
      authToken: token,
      metrics: { enabled: true, rateLimitPerMin: 60 },
      abuse: { rateLimitPerMin: 1_000 },
    });

    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await scrape(token);
      expect(response.status).toBe(200);
      await response.body?.cancel();
    }

    const limited = await scrape(token);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    const body = (await limited.json()) as RpcError;
    expect(body.error?.code).toBe(-32000);
    expect(body.error?.message).toBe("Too many metrics requests.");

    // The /mcp bucket, ban state, and health check are unaffected.
    expect((await postMcp(token)).status).toBe(200);
    const health = await fetch(`${baseUrl}/healthz`);
    expect(health.status).toBe(200);
  });

  it("does not share the /mcp rate-limit bucket", async () => {
    await restartApp({
      abuse: { rateLimitPerMin: 1 },
      metrics: { enabled: true, rateLimitPerMin: 60 },
    });

    const mcp = await fetch(`${baseUrl}/mcp`);
    expect(mcp.status).toBe(405);
    await mcp.body?.cancel();

    // The /mcp budget is exhausted, but metrics has its own limiter.
    expect((await scrape()).status).toBe(200);
  });

  it("does not trigger the /mcp auth-failure ban", async () => {
    const token = "metrics-ban-token-aaaaaaaaaaaaaaaaaaaa";
    await restartApp({
      authToken: token,
      metrics: { enabled: true, rateLimitPerMin: 0 },
      abuse: { authFailLimit: 2, rateLimitPerMin: 1_000 },
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await scrape("wrong-token")).status).toBe(401);
    }

    // Five failed metric scrapes must not ban the client from /mcp.
    expect((await postMcp(token)).status).toBe(200);
  });
});

describe("metrics configuration", () => {
  it("defaults from the bind host and accepts explicit values", () => {
    expect(resolveMetricsEnabled({}, "127.0.0.1")).toBe(true);
    expect(resolveMetricsEnabled({}, "[::1]")).toBe(true);
    expect(resolveMetricsEnabled({}, "0.0.0.0")).toBe(false);
    expect(resolveMetricsEnabled({ MCP_METRICS_ENABLED: "1" }, "0.0.0.0"))
      .toBe(true);
    expect(resolveMetricsEnabled({ MCP_METRICS_ENABLED: "YES" }, "0.0.0.0"))
      .toBe(true);
    expect(resolveMetricsEnabled({ MCP_METRICS_ENABLED: "0" }, "127.0.0.1"))
      .toBe(false);
    expect(resolveMetricsEnabled({ MCP_METRICS_ENABLED: "no" }, "127.0.0.1"))
      .toBe(false);
  });

  it("rejects invalid enabled and rate-limit values", () => {
    expect(() =>
      resolveMetricsEnabled({ MCP_METRICS_ENABLED: "on" }, "127.0.0.1")
    ).toThrow(/MCP_METRICS_ENABLED/);
    expect(() =>
      resolveMetricsConfig({}, { MCP_METRICS_RATE_LIMIT_PER_MIN: "-1" })
    ).toThrow(/MCP_METRICS_RATE_LIMIT_PER_MIN/);
    expect(() =>
      resolveMetricsConfig({}, { MCP_METRICS_RATE_LIMIT_PER_MIN: "many" })
    ).toThrow(/MCP_METRICS_RATE_LIMIT_PER_MIN/);
  });

  it("uses a separate default metrics rate limit", () => {
    expect(resolveMetricsConfig({}, {}).rateLimitPerMin).toBe(
      DEFAULT_METRICS_RATE_LIMIT_PER_MIN,
    );
    expect(
      resolveMetricsConfig({}, { MCP_METRICS_RATE_LIMIT_PER_MIN: "0" })
        .rateLimitPerMin,
    ).toBe(0);
  });

  it("parses one metrics token and rejects lists or passphrases", () => {
    expect(parseMetricsToken(undefined)).toBeUndefined();
    expect(parseMetricsToken("   ")).toBeUndefined();
    expect(parseMetricsToken(" abc ")).toBe("abc");
    expect(() => parseMetricsToken("one two")).toThrow(/MCP_METRICS_TOKEN/);
    expect(() => parseMetricsToken("one,two")).toThrow(/MCP_METRICS_TOKEN/);
  });

  it("applies the same strength rules as the other env tokens", () => {
    expect(() =>
      assertStrongMetricsToken("a".repeat(32), false)
    ).toThrow(/weak|guessable/i);
    expect(() =>
      assertStrongMetricsToken("short", false)
    ).toThrow(/32 characters/);
    expect(() => assertStrongMetricsToken("short", true)).not.toThrow();
  });
});
