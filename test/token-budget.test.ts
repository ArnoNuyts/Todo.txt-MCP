import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createTodoMcpServer } from "../server.ts";
import { MockBackend } from "./helpers/mock-backend.ts";

const approxTokens = (value: unknown) =>
  Math.ceil(JSON.stringify(value).length / 4);

describe("token budget", () => {
  it("keeps the tool list under 800 tokens", async () => {
    const server = createTodoMcpServer(new MockBackend());
    const [clientTransport, serverTransport] = InMemoryTransport
      .createLinkedPair();
    const client = new Client({
      name: "todo-txt-mcp-token-budget-test-client",
      version: "1.0.0",
    });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);

    try {
      const { tools } = await client.listTools();
      expect(approxTokens(tools)).toBeLessThanOrEqual(800);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });
});
