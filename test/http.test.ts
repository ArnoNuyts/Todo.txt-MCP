import { once } from "node:events";
import type { Server } from "node:http";
import { request as httpRequest } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createApp,
  resolveReadOnlyMode,
  type CreateAppOptions,
} from "../server.ts";
import {
  buildCorsOptions,
  DEFAULT_ALLOWED_HOSTS,
  DEFAULT_ALLOWED_ORIGINS,
  extractBearerToken,
  parseList,
  parseTrustProxy,
  resolveHttpSecurityOptions,
  tokensEqual,
} from "../logic/http-security.ts";
import { createLogger } from "../logic/logging.ts";
import { MockBackend } from "./helpers/mock-backend.ts";

interface RpcResponse {
  result?: {
    serverInfo?: { name?: string };
    tools?: Array<{ name: string }>;
    content?: Array<{ text?: string }>;
  };
  error?: { code?: number; message?: string };
}

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

const ALLOWED_ORIGIN = "http://localhost:3000";
const DISALLOWED_ORIGIN = "http://evil.example";

describe("MCP HTTP endpoint", () => {
  let httpServer: Server;
  let backend: MockBackend;
  let baseUrl: string;
  let nextId = 1;

  async function startApp(options?: CreateAppOptions) {
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

  async function restartApp(options?: CreateAppOptions) {
    await stopApp();
    await startApp(options);
  }

  async function rawRequest(
    options: {
      method?: string;
      path?: string;
      headers?: Record<string, string>;
      body?: string;
    } = {},
  ): Promise<RawResponse> {
    const address = httpServer.address() as AddressInfo;
    return await new Promise<RawResponse>((resolve, reject) => {
      const req = httpRequest({
        host: "127.0.0.1",
        port: address.port,
        method: options.method ?? "POST",
        path: options.path ?? "/mcp",
        headers: options.headers,
      }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      });
      req.on("error", reject);
      req.end(options.body);
    });
  }

  // HTTP/1.1 requires a Host header, so a request without one has to be sent
  // as raw HTTP/1.0 to exercise the middleware's missing-Host branch.
  async function socketRequest(requestText: string): Promise<RawResponse> {
    const address = httpServer.address() as AddressInfo;
    return await new Promise<RawResponse>((resolve, reject) => {
      const socket = connect(address.port, "127.0.0.1", () => {
        socket.write(requestText);
      });
      let data = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        data += chunk;
      });
      socket.on("error", reject);
      socket.on("close", () => {
        const [head, ...rest] = data.split("\r\n\r\n");
        const status = Number(head.split(" ")[1]);
        resolve({ status, headers: {}, body: rest.join("\r\n\r\n") });
      });
    });
  }

  function initializeBody() {
    return JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "http-test", version: "1.0.0" },
      },
    });
  }

  async function postWithToken(
    token?: string,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...headers,
      },
      body: initializeBody(),
    });
  }

  beforeEach(async () => {
    nextId = 1;
    backend = new MockBackend();
    await startApp();
  });

  afterEach(async () => {
    await stopApp();
  });

  async function rpc(
    method: string,
    params: unknown = {},
  ): Promise<RpcResponse> {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: nextId++,
        method,
        params,
      }),
    });

    expect(response.status).toBe(200);
    return (await response.json()) as RpcResponse;
  }

  it("initializes and lists the todo tools", async () => {
    const initialized = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "http-test", version: "1.0.0" },
    });
    expect(initialized.result?.serverInfo?.name).toBe("todo.txt-mcp");

    const listed = await rpc("tools/list");
    expect(listed.result?.tools?.map((tool) => tool.name))
      .toEqual([
        "list_todos",
        "add_todo",
        "edit_todo",
        "set_todo_status",
        "delete_todo",
      ]);
  });

  it("adds and lists a todo over HTTP", async () => {
    const added = await rpc("tools/call", {
      name: "add_todo",
      arguments: { todos: ["http todo"] },
    });
    expect(added.result?.content?.[0]?.text).toContain("Added todo [");
    expect(added.result?.content?.[0]?.text).toContain("http todo");
    expect(backend.getTodos()).toHaveLength(1);

    const listed = await rpc("tools/call", {
      name: "list_todos",
      arguments: {},
    });
    expect(listed.result?.content?.[0]?.text).toContain("http todo");
  });

  it("rejects GET /mcp with method not allowed", async () => {
    const response = await fetch(`${baseUrl}/mcp`);
    expect(response.status).toBe(405);
    const body = (await response.json()) as RpcResponse;
    expect(body.error?.message).toBe("Method not allowed.");
  });

  it("rejects DELETE /mcp with method not allowed", async () => {
    const response = await fetch(`${baseUrl}/mcp`, { method: "DELETE" });
    expect(response.status).toBe(405);
    const body = (await response.json()) as RpcResponse;
    expect(body.error?.message).toBe("Method not allowed.");
  });

  it("returns a JSON-RPC parse error for malformed JSON", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: "{not json",
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as RpcResponse;
    expect(body.error?.code).toBe(-32700);
  });

  it("allows requests without an Origin header", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: initializeBody(),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    const body = (await response.json()) as RpcResponse;
    expect(body.result?.serverInfo?.name).toBe("todo.txt-mcp");
  });

  it("echoes an allowed Origin in the CORS header and never uses a wildcard", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        origin: ALLOWED_ORIGIN,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: initializeBody(),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin"))
      .toBe(ALLOWED_ORIGIN);
    expect(response.headers.get("access-control-allow-origin")).not.toBe("*");
    const body = (await response.json()) as RpcResponse;
    expect(body.result?.serverInfo?.name).toBe("todo.txt-mcp");
  });

  it("rejects a disallowed Origin with a 403 JSON-RPC error", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        origin: DISALLOWED_ORIGIN,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: initializeBody(),
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    const body = (await response.json()) as RpcResponse;
    expect(body.error?.code).toBe(-32000);
  });

  it("rejects a disallowed Host with a 403 JSON-RPC error", async () => {
    const response = await rawRequest({
      headers: {
        host: "evil.example",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: initializeBody(),
    });

    expect(response.status).toBe(403);
    const body = JSON.parse(response.body) as RpcResponse;
    expect(body.error?.code).toBe(-32000);
    expect(body.error?.message).toContain("Invalid Host");
  });

  it("rejects a missing Host with a 403 JSON-RPC error", async () => {
    const body = initializeBody();
    const response = await socketRequest(
      `POST /mcp HTTP/1.0\r\n` +
        `Content-Type: application/json\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        `\r\n${body}`,
    );

    expect(response.status).toBe(403);
    const json = JSON.parse(response.body) as RpcResponse;
    expect(json.error?.code).toBe(-32000);
    expect(json.error?.message).toContain("Missing Host");
  });

  it("accepts hosts injected through options", async () => {
    await restartApp({ allowedHosts: ["example.test"] });

    const rejected = await rawRequest({
      headers: { "content-type": "application/json" },
      body: initializeBody(),
    });
    expect(rejected.status).toBe(403);

    const accepted = await rawRequest({
      headers: {
        host: "example.test",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: initializeBody(),
    });
    expect(accepted.status).toBe(200);
    expect((JSON.parse(accepted.body) as RpcResponse).result?.serverInfo?.name)
      .toBe("todo.txt-mcp");
  });

  it("rejects browser Origins when the origin allowlist is empty", async () => {
    await restartApp({ allowedOrigins: [] });

    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        origin: DISALLOWED_ORIGIN,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: initializeBody(),
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    const body = (await response.json()) as RpcResponse;
    expect(body.error?.message).toContain("Origin");
  });

  it("still accepts non-browser requests when the origin allowlist is empty", async () => {
    await restartApp({ allowedOrigins: [] });

    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: initializeBody(),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    const body = (await response.json()) as RpcResponse;
    expect(body.result?.serverInfo?.name).toBe("todo.txt-mcp");
  });

  it("requires a bearer token on /mcp when configured", async () => {
    await restartApp({ authToken: "s3cret-token" });

    const missing = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: initializeBody(),
    });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe("Bearer");
    const missingBody = (await missing.json()) as RpcResponse;
    expect(missingBody.error?.code).toBe(-32001);

    const wrong = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer wrong-token",
        "content-type": "application/json",
      },
      body: initializeBody(),
    });
    expect(wrong.status).toBe(401);
    expect((await wrong.json() as RpcResponse).error?.code).toBe(-32001);

    const accepted = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer s3cret-token",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: initializeBody(),
    });
    expect(accepted.status).toBe(200);
    const acceptedBody = (await accepted.json()) as RpcResponse;
    expect(acceptedBody.result?.serverInfo?.name).toBe("todo.txt-mcp");
  });

  it("serves /healthz without authentication", async () => {
    await restartApp({ authToken: "s3cret-token" });

    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("does not require auth when no token is configured", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: initializeBody(),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as RpcResponse;
    expect(body.result?.serverInfo?.name).toBe("todo.txt-mcp");
  });

  it("accepts any active token during rotation", async () => {
    await restartApp({
      authTokens: [
        "rotation-token-one-aaaaaaaaaaaaaaaa",
        "rotation-token-two-bbbbbbbbbbbbbbbb",
      ],
    });

    for (
      const token of [
        "rotation-token-one-aaaaaaaaaaaaaaaa",
        "rotation-token-two-bbbbbbbbbbbbbbbb",
      ]
    ) {
      const response = await postWithToken(token);
      expect(response.status).toBe(200);
      await response.body?.cancel();
    }

    const rejected = await postWithToken("rotation-token-three-cccccccc");
    expect(rejected.status).toBe(401);
    await rejected.body?.cancel();
  });

  it("exposes only list_todos in read-only mode", async () => {
    await restartApp({ readOnly: true });

    const listed = await rpc("tools/list");
    expect(listed.result?.tools?.map((tool) => tool.name)).toEqual([
      "list_todos",
    ]);

    const attempted = await rpc("tools/call", {
      name: "add_todo",
      arguments: { todos: ["should not be added"] },
    });
    const attemptMessage = attempted.error?.message ??
      attempted.result?.content?.map((item) => item.text ?? "").join(" ") ??
      "";
    expect(attemptMessage).toMatch(/not found|unknown|unsupported/i);
    expect(backend.getTodos()).toHaveLength(0);
  });

  it("sets security headers and hides the framework name", async () => {
    const mcp = await fetch(`${baseUrl}/mcp`);
    expect(mcp.status).toBe(405);
    expect(mcp.headers.get("x-powered-by")).toBeNull();
    expect(mcp.headers.get("x-content-type-options")).toBe("nosniff");
    expect(mcp.headers.get("referrer-policy")).toBe("no-referrer");
    expect(mcp.headers.get("cache-control")).toBe("no-store");
    await mcp.body?.cancel();

    const metrics = await fetch(`${baseUrl}/metrics`);
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get("x-powered-by")).toBeNull();
    expect(metrics.headers.get("x-content-type-options")).toBe("nosniff");
    expect(metrics.headers.get("referrer-policy")).toBe("no-referrer");
    expect(metrics.headers.get("cache-control")).toBe("no-store");
    expect(metrics.headers.get("content-type"))
      .toContain("text/plain");
    await metrics.body?.cancel();
  });

  it("echoes a valid request ID and replaces an invalid one", async () => {
    const valid = await fetch(`${baseUrl}/healthz`, {
      headers: { "x-request-id": "client-request_1.2" },
    });
    expect(valid.status).toBe(200);
    expect(valid.headers.get("x-request-id")).toBe("client-request_1.2");

    const invalid = await fetch(`${baseUrl}/healthz`, {
      headers: { "x-request-id": "not a valid id!" },
    });
    expect(invalid.status).toBe(200);
    const generated = invalid.headers.get("x-request-id");
    expect(generated).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(generated).not.toBe("not a valid id!");
  });

  it("never writes bearer tokens or bodies to the log output", async () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "debug",
      stdout: (line) => lines.push(line),
      stderr: (line) => lines.push(line),
    });
    const token = "log-secret-token-aaaaaaaaaaaaaaaa";
    await restartApp({
      authToken: token,
      logger,
      abuse: { authFailLimit: 100, rateLimitPerMin: 1_000 },
    });

    await (await postWithToken(token)).text();
    await (await postWithToken("wrong-log-token-bbbbbbbbbbbb")).text();

    const output = lines.join("\n");
    expect(output).not.toContain(token);
    expect(output).not.toContain("wrong-log-token-bbbbbbbbbbbb");
    expect(output).not.toContain("Bearer");
    expect(output).not.toContain("todo_secret_content");

    const records = lines.map((line) => JSON.parse(line) as {
      msg?: string;
      requestId?: string;
      path?: string;
      auth?: string;
    });
    const requests = records.filter((record) => record.msg === "request");
    expect(requests.some((record) => record.path === "/mcp")).toBe(true);
    expect(requests.some((record) => record.auth === "fail")).toBe(true);
    expect(requests.every((record) => typeof record.requestId === "string"))
      .toBe(true);
  });

  it("serves open metrics with request counters when auth is disabled", async () => {
    await fetch(`${baseUrl}/healthz`);
    await fetch(`${baseUrl}/healthz`);

    const response = await fetch(`${baseUrl}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    const text = await response.text();
    expect(text).toContain("# TYPE todo_mcp_requests_total counter");
    expect(text).toContain("todo_mcp_requests_total 2");
    expect(text).toContain("todo_mcp_responses_2xx_total 2");
    expect(text).toContain("todo_mcp_auth_failures_total 0");
  });

  it("protects metrics with the same bearer token when configured", async () => {
    await restartApp({ authToken: "metrics-token-aaaaaaaaaaaaaaaaaaaa" });

    const unauthorized = await fetch(`${baseUrl}/metrics`);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toBe("Bearer");
    await unauthorized.body?.cancel();

    const authorized = await fetch(`${baseUrl}/metrics`, {
      headers: {
        authorization: "Bearer metrics-token-aaaaaaaaaaaaaaaaaaaa",
      },
    });
    expect(authorized.status).toBe(200);
    const text = await authorized.text();
    expect(text).toContain("todo_mcp_auth_failures_total 1");
    expect(text).toContain("todo_mcp_responses_401_total 1");
  });

  it("locks out a key after repeated bad tokens", async () => {
    await restartApp({
      authToken: "s3cret-token",
      abuse: { authFailLimit: 3, authBanSec: 60, rateLimitPerMin: 1_000 },
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await postWithToken("wrong-token");
      expect(response.status).toBe(401);
      expect((await response.json() as RpcResponse).error?.code).toBe(-32001);
    }

    const locked = await postWithToken("wrong-token");
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBe("60");
    const lockedBody = (await locked.json()) as RpcResponse;
    expect(lockedBody.error?.code).toBe(-32000);
    expect(lockedBody.error?.message).toBe(
      "Too many failed authentication attempts.",
    );

    // A correct token is still rejected while the ban is active.
    const bannedGoodToken = await postWithToken("s3cret-token");
    expect(bannedGoodToken.status).toBe(429);
    expect((await bannedGoodToken.json() as RpcResponse).error?.message).toBe(
      "Too many failed authentication attempts.",
    );

    const health = await fetch(`${baseUrl}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
  });

  it("resets the failed-auth counter after a successful login", async () => {
    await restartApp({
      authToken: "s3cret-token",
      abuse: { authFailLimit: 3, rateLimitPerMin: 1_000 },
    });

    expect((await postWithToken("wrong-token")).status).toBe(401);
    expect((await postWithToken("wrong-token")).status).toBe(401);
    expect((await postWithToken("s3cret-token")).status).toBe(200);

    expect((await postWithToken("wrong-token")).status).toBe(401);
    expect((await postWithToken("wrong-token")).status).toBe(401);
  });

  it("expires a ban automatically using the injected clock", async () => {
    let now = 1_000_000;
    await restartApp({
      authToken: "s3cret-token",
      abuse: {
        authFailLimit: 2,
        authBanSec: 60,
        rateLimitPerMin: 1_000,
        now: () => now,
      },
    });

    expect((await postWithToken("wrong-token")).status).toBe(401);
    expect((await postWithToken("wrong-token")).status).toBe(429);
    expect((await postWithToken("s3cret-token")).status).toBe(429);

    now += 60_001;
    expect((await postWithToken("s3cret-token")).status).toBe(200);
  });

  it("ignores spoofed X-Forwarded-For when trust proxy is off", async () => {
    await restartApp({
      authToken: "s3cret-token",
      trustProxy: false,
      abuse: { authFailLimit: 2, rateLimitPerMin: 1_000 },
    });

    const first = await postWithToken("wrong-token", {
      "x-forwarded-for": "203.0.113.10",
    });
    expect(first.status).toBe(401);

    // A different spoofed address still maps to the same socket key.
    const second = await postWithToken("wrong-token", {
      "x-forwarded-for": "203.0.113.11",
    });
    expect(second.status).toBe(429);
  });

  it("uses X-Forwarded-For when trust proxy is explicitly enabled", async () => {
    await restartApp({
      authToken: "s3cret-token",
      trustProxy: true,
      abuse: { authFailLimit: 2, rateLimitPerMin: 1_000 },
    });

    const first = await postWithToken("wrong-token", {
      "x-forwarded-for": "203.0.113.10",
    });
    expect(first.status).toBe(401);
    const second = await postWithToken("wrong-token", {
      "x-forwarded-for": "203.0.113.11",
    });
    expect(second.status).toBe(401);
    const third = await postWithToken("wrong-token", {
      "x-forwarded-for": "203.0.113.10",
    });
    expect(third.status).toBe(429);
  });

  it("opens the global circuit breaker on distributed auth failures", async () => {
    const warnings: Array<Record<string, unknown>> = [];
    const logger = createLogger({
      level: "debug",
      stdout: () => {},
      stderr: (line) => {
        warnings.push(JSON.parse(line) as Record<string, unknown>);
      },
    });
    await restartApp({
      authToken: "s3cret-token",
      logger,
      abuse: {
        authFailLimit: 100,
        globalAuthFailLimit: 2,
        globalAuthFailWindowSec: 60,
        globalBreakerCooldownSec: 60,
        rateLimitPerMin: 1_000,
      },
    });

    expect((await postWithToken("wrong-token")).status).toBe(401);
    expect((await postWithToken("wrong-token")).status).toBe(401);

    const shed = await postWithToken("s3cret-token");
    expect(shed.status).toBe(503);
    expect(shed.headers.get("retry-after")).toBe("60");
    const shedBody = (await shed.json()) as RpcResponse;
    expect(shedBody.error?.message).toContain("temporarily unavailable");
    expect(warnings).toContainEqual(expect.objectContaining({
      msg: "auth_failure_circuit_breaker",
      requestId: expect.any(String),
    }));

    const health = await fetch(`${baseUrl}/healthz`);
    expect(health.status).toBe(200);
  });

  it("emits rate limit headers and rejects excess requests", async () => {
    await restartApp({ abuse: { rateLimitPerMin: 2 } });

    const first = await fetch(`${baseUrl}/mcp`);
    expect(first.status).toBe(405);
    expect(first.headers.get("ratelimit-limit")).toBe("2");
    expect(first.headers.get("ratelimit-remaining")).toBe("1");
    expect(Number(first.headers.get("ratelimit-reset"))).toBeGreaterThan(0);
    await first.body?.cancel();

    const second = await fetch(`${baseUrl}/mcp`);
    expect(second.status).toBe(405);
    expect(second.headers.get("ratelimit-remaining")).toBe("0");
    await second.body?.cancel();

    const third = await fetch(`${baseUrl}/mcp`);
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("60");
    expect(third.headers.get("ratelimit-limit")).toBe("2");
    expect(third.headers.get("ratelimit-remaining")).toBe("0");
    const body = (await third.json()) as RpcResponse;
    expect(body.error?.code).toBe(-32000);
    expect(body.error?.message).toBe("Too many requests.");
  });

  it("returns 503 instead of queueing beyond the concurrency cap", async () => {
    const slowBackend = new MockBackend();
    const originalLoad = slowBackend.load.bind(slowBackend);
    let firstLoad = true;
    let releaseLoad: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    let signalLoadStarted: () => void = () => {};
    const loadStarted = new Promise<void>((resolve) => {
      signalLoadStarted = resolve;
    });

    slowBackend.load = async () => {
      if (firstLoad) {
        firstLoad = false;
        signalLoadStarted();
        await gate;
      }
      return await originalLoad();
    };

    backend = slowBackend;
    await restartApp({
      abuse: { maxConcurrency: 1, rateLimitPerMin: 1_000 },
    });

    const callBody = () =>
      JSON.stringify({
        jsonrpc: "2.0",
        id: nextId++,
        method: "tools/call",
        params: { name: "list_todos", arguments: {} },
      });
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };

    const firstPromise = fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: callBody(),
    });
    await loadStarted;

    const rejected = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: callBody(),
    });
    expect(rejected.status).toBe(503);
    expect(rejected.headers.get("retry-after")).toBe("1");
    const rejectedBody = (await rejected.json()) as RpcResponse;
    expect(rejectedBody.error?.message).toContain("busy");

    releaseLoad();
    const first = await firstPromise;
    expect(first.status).toBe(200);
    await first.body?.cancel();
  });
});

describe("HTTP security helpers", () => {
  it("parses comma-separated lists with defaults and explicit empties", () => {
    expect(parseList(undefined, DEFAULT_ALLOWED_HOSTS))
      .toEqual(DEFAULT_ALLOWED_HOSTS);
    expect(parseList(" localhost, 127.0.0.1 ,,[::1] ", ["fallback"]))
      .toEqual(["localhost", "127.0.0.1", "[::1]"]);
    expect(parseList([" a ", "", "b"], ["fallback"])).toEqual(["a", "b"]);
    expect(parseList("", DEFAULT_ALLOWED_ORIGINS)).toEqual([]);
  });

  it("parses trust proxy settings and rejects malformed values", () => {
    expect(parseTrustProxy(undefined)).toBeUndefined();
    expect(parseTrustProxy("false")).toBe(false);
    expect(parseTrustProxy("FALSE")).toBe(false);
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy("true")).toBe(true);
    expect(parseTrustProxy("2")).toBe(2);
    expect(parseTrustProxy("loopback")).toBe("loopback");
    expect(parseTrustProxy("127.0.0.1")).toBe("127.0.0.1");
    expect(parseTrustProxy("10.0.0.0/8, 172.16.0.0/12")).toEqual([
      "10.0.0.0/8",
      "172.16.0.0/12",
    ]);
    expect(() => parseTrustProxy("not-an-ip")).toThrow();
    expect(() => parseTrustProxy("10.0.0.0/33")).toThrow();
    expect(() => parseTrustProxy("-1")).toThrow();
  });

  it("resolves env defaults and option overrides", () => {
    expect(resolveHttpSecurityOptions({}, {})).toEqual({
      allowedHosts: DEFAULT_ALLOWED_HOSTS,
      allowedOrigins: DEFAULT_ALLOWED_ORIGINS,
      authToken: undefined,
      authTokens: [],
    });

    expect(resolveHttpSecurityOptions({}, {
      MCP_ALLOWED_HOSTS: "todo.local",
      MCP_ALLOWED_ORIGINS: "https://todo.local, https://alt.local",
      MCP_AUTH_TOKEN: "env-token",
    })).toEqual({
      allowedHosts: ["todo.local"],
      allowedOrigins: ["https://todo.local", "https://alt.local"],
      authToken: "env-token",
      authTokens: ["env-token"],
    });

    expect(resolveHttpSecurityOptions({
      allowedHosts: ["override.local"],
      allowedOrigins: [],
      authToken: "option-token",
    }, {
      MCP_ALLOWED_HOSTS: "env.local",
      MCP_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
      MCP_AUTH_TOKEN: "env-token",
    })).toEqual({
      allowedHosts: ["override.local"],
      allowedOrigins: [],
      authToken: "option-token",
      authTokens: ["option-token"],
    });

    expect(resolveHttpSecurityOptions({ authToken: "  " }, {}).authToken)
      .toBeUndefined();

    expect(resolveHttpSecurityOptions({}, {
      MCP_AUTH_TOKENS: "list-one, list-two",
    })).toMatchObject({
      authToken: "list-one",
      authTokens: ["list-one", "list-two"],
    });
  });

  it("compares tokens in constant time", () => {
    expect(tokensEqual("secret", "secret")).toBe(true);
    expect(tokensEqual("secret", "secreT")).toBe(false);
    expect(tokensEqual("secret", "short")).toBe(false);
    expect(tokensEqual("a".repeat(64), "a".repeat(63))).toBe(false);
    expect(tokensEqual("héllo", "héllo")).toBe(true);
  });

  it("resolves read-only mode from options and the environment", () => {
    expect(resolveReadOnlyMode({}, {})).toBe(false);
    expect(resolveReadOnlyMode({}, { MCP_READ_ONLY: "1" })).toBe(true);
    expect(resolveReadOnlyMode({}, { MCP_READ_ONLY: "true" })).toBe(true);
    expect(resolveReadOnlyMode({}, { MCP_READ_ONLY: "yes" })).toBe(true);
    expect(resolveReadOnlyMode({}, { MCP_READ_ONLY: "0" })).toBe(false);
    expect(resolveReadOnlyMode({ readOnly: false }, { MCP_READ_ONLY: "1" }))
      .toBe(false);
  });

  it("extracts bearer tokens", () => {
    expect(extractBearerToken(undefined)).toBeUndefined();
    expect(extractBearerToken("")).toBeUndefined();
    expect(extractBearerToken("Basic abc")).toBeUndefined();
    expect(extractBearerToken("Bearer abc")).toBe("abc");
    expect(extractBearerToken("bearer\tabc")).toBe("abc");
  });

  it("builds an explicit CORS allowlist without wildcards", () => {
    const options = buildCorsOptions([ALLOWED_ORIGIN]);
    expect(options.origin).toEqual([ALLOWED_ORIGIN]);
    expect(options.methods).toEqual(["GET", "POST", "DELETE", "OPTIONS"]);
    expect(options.allowedHeaders).toEqual([
      "content-type",
      "authorization",
      "mcp-session-id",
      "mcp-protocol-version",
    ]);
    expect(options.exposedHeaders).toEqual(["mcp-session-id"]);
    expect(JSON.stringify(options)).not.toContain('"*"');
  });
});
