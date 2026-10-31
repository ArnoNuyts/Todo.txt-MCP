import { once } from "node:events";
import type { Server } from "node:http";
import { request as httpRequest } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type CreateAppOptions } from "../server.ts";
import {
  buildCorsOptions,
  DEFAULT_ALLOWED_HOSTS,
  DEFAULT_ALLOWED_ORIGINS,
  extractBearerToken,
  parseList,
  resolveHttpSecurityOptions,
  tokensEqual,
} from "../logic/http-security.ts";
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

  it("emits no CORS headers when the origin allowlist is empty", async () => {
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

  it("resolves env defaults and option overrides", () => {
    expect(resolveHttpSecurityOptions({}, {})).toEqual({
      allowedHosts: DEFAULT_ALLOWED_HOSTS,
      allowedOrigins: DEFAULT_ALLOWED_ORIGINS,
      authToken: undefined,
    });

    expect(resolveHttpSecurityOptions({}, {
      MCP_ALLOWED_HOSTS: "todo.local",
      MCP_ALLOWED_ORIGINS: "https://todo.local, https://alt.local",
      MCP_AUTH_TOKEN: "env-token",
    })).toEqual({
      allowedHosts: ["todo.local"],
      allowedOrigins: ["https://todo.local", "https://alt.local"],
      authToken: "env-token",
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
    });

    expect(resolveHttpSecurityOptions({ authToken: "  " }, {}).authToken)
      .toBeUndefined();
  });

  it("compares tokens in constant time", () => {
    expect(tokensEqual("secret", "secret")).toBe(true);
    expect(tokensEqual("secret", "secreT")).toBe(false);
    expect(tokensEqual("secret", "short")).toBe(false);
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
