import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createTodoMcpServer, type TodoToolset } from "../server.ts";
import { MockBackend } from "./helpers/mock-backend.ts";

const approxTokens = (value: unknown) =>
  Math.ceil(JSON.stringify(value).length / 4);

async function toolListTokens(toolset: TodoToolset): Promise<number> {
  const server = createTodoMcpServer(new MockBackend(), { toolset });
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
    return approxTokens(tools);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

describe("token budget", () => {
  it("keeps the compact tools/list at least 50% below the full profile", async () => {
    const full = await toolListTokens("full");
    const compact = await toolListTokens("compact");
    const compactPlus = await toolListTokens("compact-plus");

    // The end-to-end action benchmark lives in bench/actions.ts. This guards
    // the fixed per-session context cost in CI.
    expect(compact).toBeLessThanOrEqual(full / 2);
    expect(compactPlus).toBeLessThanOrEqual(full / 2);
  });
});
