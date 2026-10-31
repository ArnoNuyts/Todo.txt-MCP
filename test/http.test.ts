import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../server.ts";
import { MockBackend } from "./helpers/mock-backend.ts";

interface RpcResponse {
  result?: {
    serverInfo?: { name?: string };
    tools?: Array<{ name: string }>;
    content?: Array<{ text?: string }>;
  };
  error?: { message?: string };
}

describe("POST /mcp", () => {
  let httpServer: Server;
  let backend: MockBackend;
  let baseUrl: string;
  let nextId = 1;

  beforeEach(async () => {
    backend = new MockBackend();
    httpServer = createApp(backend).listen(0, "127.0.0.1");
    await once(httpServer, "listening");
    const address = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => error ? reject(error) : resolve());
    });
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
      .toEqual(["list_todos", "add_todo", "edit_todo", "set_todo_status"]);
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
});
