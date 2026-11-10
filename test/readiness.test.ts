import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../server.ts";
import { LocalFileBackend } from "../logic/backends/local-file-backend.ts";
import type { TodoBackend } from "../logic/backend.ts";
import { createReadinessProbe } from "../logic/readiness.ts";
import type { Todo } from "../logic/todo.ts";

describe("readiness probe", () => {
  let tempDir = "";
  let httpServer: Server | undefined;
  let baseUrl = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "todo-txt-mcp-readyz-"));
  });

  afterEach(async () => {
    if (httpServer?.listening) {
      await new Promise<void>((resolve, reject) => {
        httpServer?.close((error) => error ? reject(error) : resolve());
      });
    }
    httpServer = undefined;
    await rm(tempDir, { recursive: true, force: true });
  });

  async function startApp(
    backend: TodoBackend,
    options: { readinessTimeoutMs?: number } = {},
  ) {
    httpServer = createApp(backend, {
      authToken: "readyz-token-aaaaaaaaaaaaaaaaaaaaaaaa",
      ...options,
    }).listen(0, "127.0.0.1");
    await once(httpServer, "listening");
    const address = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  it("returns ready for a valid file while healthz stays cheap", async () => {
    const filename = join(tempDir, "todo.txt");
    await writeFile(filename, "task one\ntask two\n");

    await startApp(new LocalFileBackend(filename));

    // /readyz is unauthenticated even when /mcp requires a token.
    const ready = await fetch(`${baseUrl}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: "ready" });

    const health = await fetch(`${baseUrl}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
  });

  it("returns unavailable for an unreadable backend without leaking details", async () => {
    const filename = join(tempDir, "todo.txt");
    await writeFile(filename, Buffer.from([0x76, 0x61, 0x6c, 0x69, 0x64, 0xff]));

    await startApp(new LocalFileBackend(filename));

    const ready = await fetch(`${baseUrl}/readyz`);
    expect(ready.status).toBe(503);
    const body = await ready.json();
    expect(body).toEqual({ status: "unavailable" });
    expect(JSON.stringify(body)).not.toContain(filename);
    expect(JSON.stringify(body)).not.toContain("UTF-8");

    const health = await fetch(`${baseUrl}/healthz`);
    expect(health.status).toBe(200);
  });

  it("returns unavailable when the backend does not answer in time", async () => {
    const hangingBackend: TodoBackend = {
      load: () => new Promise<Todo[]>(() => {}),
      save: async () => {},
    };

    await startApp(hangingBackend, { readinessTimeoutMs: 50 });

    const startedAt = Date.now();
    const ready = await fetch(`${baseUrl}/readyz`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ status: "unavailable" });
    expect(Date.now() - startedAt).toBeLessThan(2_000);

    const health = await fetch(`${baseUrl}/healthz`);
    expect(health.status).toBe(200);
  });

  it("shares one in-flight load across concurrent probes", async () => {
    let loads = 0;
    const backend: TodoBackend = {
      load: async () => {
        loads += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return [];
      },
      save: async () => {},
    };
    const probe = createReadinessProbe(backend, 1_000);

    const results = await Promise.all([probe(), probe(), probe()]);

    expect(results).toEqual([{ ready: true }, { ready: true }, { ready: true }]);
    expect(loads).toBe(1);
  });

  it("returns a server-side reason when the backend fails", async () => {
    const backend: TodoBackend = {
      load: async () => {
        throw new Error("backend unavailable");
      },
      save: async () => {},
    };

    await expect(createReadinessProbe(backend, 1_000)()).resolves.toEqual({
      ready: false,
      reason: "backend unavailable",
    });
  });
});
