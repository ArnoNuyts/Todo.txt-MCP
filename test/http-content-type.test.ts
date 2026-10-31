import { once } from "node:events";
import type { Server } from "node:http";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../server.ts";
import { isJsonContentType } from "../logic/content-type.ts";
import { MockBackend } from "./helpers/mock-backend.ts";

interface RpcBody {
  result?: { serverInfo?: { name?: string } };
  error?: { code?: number; message?: string };
}

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

describe("POST /mcp content-type guard", () => {
  let httpServer: Server;

  function initializeBody() {
    return JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "content-type-test", version: "1.0.0" },
      },
    });
  }

  async function rawRequest(
    headers: Record<string, string>,
    body: string,
  ): Promise<RawResponse> {
    const address = httpServer.address() as AddressInfo;
    return await new Promise<RawResponse>((resolve, reject) => {
      const req = httpRequest({
        host: "127.0.0.1",
        port: address.port,
        method: "POST",
        path: "/mcp",
        headers,
      }, (res) => {
        let received = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          received += chunk;
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: received,
          });
        });
      });
      req.on("error", reject);
      req.end(body);
    });
  }

  beforeEach(async () => {
    httpServer = createApp(new MockBackend()).listen(0, "127.0.0.1");
    await once(httpServer, "listening");
  });

  afterEach(async () => {
    if (!httpServer.listening) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => error ? reject(error) : resolve());
    });
  });

  it.each(["text/plain", "application/x-www-form-urlencoded", "text/json"])(
    "rejects %s with 415 and a JSON-RPC error",
    async (contentType) => {
      const response = await rawRequest(
        {
          "content-type": contentType,
          accept: "application/json, text/event-stream",
        },
        initializeBody(),
      );

      expect(response.status).toBe(415);
      const body = JSON.parse(response.body) as RpcBody;
      expect(body.error?.code).toBe(-32000);
      expect(body.error?.message).toContain("Unsupported Media Type");
      expect(body.result).toBeUndefined();
    },
  );

  it("accepts application/json with a charset parameter", async () => {
    const response = await rawRequest(
      {
        "content-type": "application/json; charset=utf-8",
        accept: "application/json, text/event-stream",
      },
      initializeBody(),
    );

    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as RpcBody;
    expect(body.result?.serverInfo?.name).toBe("todo.txt-mcp");
  });

  it("accepts application/*+json media types", async () => {
    const response = await rawRequest(
      {
        "content-type": "application/vnd.api+json",
        accept: "application/json, text/event-stream",
      },
      initializeBody(),
    );

    expect(response.status).toBe(200);
    expect((JSON.parse(response.body) as RpcBody).result?.serverInfo?.name)
      .toBe("todo.txt-mcp");
  });

  it("allows a missing Content-Type header for CLI clients", async () => {
    const body = initializeBody();
    const response = await rawRequest(
      {
        accept: "application/json, text/event-stream",
        "content-length": String(Buffer.byteLength(body)),
      },
      body,
    );

    expect(response.status).toBe(200);
    expect((JSON.parse(response.body) as RpcBody).result?.serverInfo?.name)
      .toBe("todo.txt-mcp");
  });
});

describe("isJsonContentType", () => {
  it("allows missing, JSON and structured JSON media types", () => {
    expect(isJsonContentType(undefined)).toBe(true);
    expect(isJsonContentType("application/json")).toBe(true);
    expect(isJsonContentType("Application/JSON; charset=utf-8")).toBe(true);
    expect(isJsonContentType("application/problem+json")).toBe(true);
    expect(isJsonContentType("application/vnd.api+json; charset=utf-8"))
      .toBe(true);
  });

  it("rejects non-JSON media types", () => {
    expect(isJsonContentType("text/plain")).toBe(false);
    expect(isJsonContentType("application/xml")).toBe(false);
    expect(isJsonContentType("application/json-patch")).toBe(false);
    expect(isJsonContentType("")).toBe(false);
  });
});
