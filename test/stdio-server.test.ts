import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { runStdioServer } from "../server.ts";
import type { TodoBackend } from "../logic/backend.ts";
import { Todo } from "../logic/todo.ts";

const MESSAGE_INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "stdio-server-test", version: "1.0.0" },
  },
};

const MESSAGE_ADD = {
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: "add_todos", arguments: { todos: ["new task"] } },
};

class BlockingBackend implements TodoBackend {
  private readonly gate: Promise<void>;
  private releaseGate!: () => void;
  private signalLoad!: () => void;
  readonly loadStarted = new Promise<void>((resolve) => {
    this.signalLoad = resolve;
  });
  saved = false;
  private todos: Todo[] = [new Todo("existing task")];

  constructor() {
    this.gate = new Promise<void>((resolve) => {
      this.releaseGate = resolve;
    });
  }

  async load(): Promise<Todo[]> {
    this.signalLoad();
    await this.gate;
    return this.todos;
  }

  async save(todos: Todo[]): Promise<void> {
    this.saved = true;
    this.todos = todos;
  }

  release(): void {
    this.releaseGate();
  }
}

describe("stdio server shutdown", () => {
  it("drains an in-flight tool call before closing", async () => {
    const backend = new BlockingBackend();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const running = runStdioServer(backend, { stdin, stdout });

    stdin.write(`${JSON.stringify(MESSAGE_INITIALIZE)}\n`);
    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    stdin.write(`${JSON.stringify(MESSAGE_ADD)}\n`);

    await backend.loadStarted;
    stdin.end();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(backend.saved).toBe(false);

    backend.release();
    await running;

    expect(backend.saved).toBe(true);
    expect(stdin.listenerCount("data")).toBe(0);
    expect(stdout.listenerCount("data")).toBe(0);
  });
});
