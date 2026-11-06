import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTodoMcpServer } from "../server.ts";
import { MockBackend } from "./helpers/mock-backend.ts";
import { Todo } from "../logic/todo.ts";
import { serializeTodoContent } from "../logic/content.ts";

describe("errors and resources", () => {
  let backend: MockBackend;
  let client: Client;
  let server: ReturnType<typeof createTodoMcpServer>;

  beforeEach(async () => {
    backend = new MockBackend();
    await backend.save([
      new Todo("open one @Home"),
      new Todo("open two @work"),
      new Todo("x 2026-05-01 2026-04-01 done one @home"),
    ]);
    backend.saveCalls = 0;
    server = createTodoMcpServer(backend);
    const [clientTransport, serverTransport] = InMemoryTransport
      .createLinkedPair();
    client = new Client({ name: "resources-test", version: "1.0.0" });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
  });

  afterEach(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });

  it("reads the whole file without mutating the backend", async () => {
    const result = await client.readResource({ uri: "todo://file" });
    const [content] = result.contents as Array<{ text?: string }>;

    expect(content.text).toBe(serializeTodoContent(backend.getTodos()));
    expect(backend.saveCalls).toBe(0);
  });

  it("reads only open todos from todo://active", async () => {
    const result = await client.readResource({ uri: "todo://active" });
    const [content] = result.contents as Array<{ text?: string }>;

    expect(content.text).toBe("open one @Home\nopen two @work\n");
    expect(content.text).not.toContain("done one");
    expect(backend.saveCalls).toBe(0);
  });

  it("reads one context through the resource template", async () => {
    const result = await client.readResource({ uri: "todo://context/home" });
    const [content] = result.contents as Array<{ text?: string }>;

    expect(content.text).toBe("open one @Home\n");
    expect(backend.saveCalls).toBe(0);
  });

  it("returns a stable error code for a missing hash", async () => {
    const result = await client.callTool({
      name: "mark_done",
      arguments: { hashes: ["0123456789abcdef"] },
    });

    expect(result.isError).toBe(true);
    expect(
      (result as { structuredContent?: { error?: { code?: string } } })
        .structuredContent?.error?.code,
    ).toBe("TODO_NOT_FOUND");
  });

  it("exposes the todo_format prompt", async () => {
    const result = await client.getPrompt({ name: "todo_format" });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toMatchObject({ type: "text" });
  });
});
