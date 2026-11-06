import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTodoMcpServer, resolveReadOnlyMode } from "../server.ts";
import { MockBackend } from "./helpers/mock-backend.ts";

interface ToolTextResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}

function textOf(result: unknown): string {
  return (result as ToolTextResult).content
    .map((item) => item.text ?? "")
    .join("\n");
}

describe("read-only mode", () => {
  let backend: MockBackend;
  let client: Client;
  let server: ReturnType<typeof createTodoMcpServer>;

  beforeEach(async () => {
    backend = new MockBackend();
    server = createTodoMcpServer(backend, { readOnly: true });
    const [clientTransport, serverTransport] = InMemoryTransport
      .createLinkedPair();
    client = new Client({
      name: "todo-txt-mcp-read-only-test-client",
      version: "1.0.0",
    });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
  });

  afterEach(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });

  it("resolves explicit options before MCP_READ_ONLY", () => {
    expect(resolveReadOnlyMode({}, {})).toBe(false);
    expect(resolveReadOnlyMode({}, { MCP_READ_ONLY: "1" })).toBe(true);
    expect(resolveReadOnlyMode({}, { MCP_READ_ONLY: "true" })).toBe(true);
    expect(resolveReadOnlyMode({}, { MCP_READ_ONLY: "yes" })).toBe(true);
    expect(resolveReadOnlyMode({}, { MCP_READ_ONLY: "0" })).toBe(false);
    expect(resolveReadOnlyMode({ readOnly: false }, { MCP_READ_ONLY: "1" }))
      .toBe(false);
    expect(resolveReadOnlyMode({ readOnly: true }, { MCP_READ_ONLY: "0" }))
      .toBe(true);
  });

  it("exposes only list_todos but keeps resources available", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["list_todos"]);

    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri)).toContain("todo://file");
  });

  it("still allows listing todos", async () => {
    const result = await client.callTool({
      name: "list_todos",
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("No todos found");
  });

  it("does not expose mutating tools", async () => {
    const result = await client.callTool({
      name: "add_todos",
      arguments: { todos: ["blocked"] },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not found");
  });
});
