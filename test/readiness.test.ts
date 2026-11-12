import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type CreateAppOptions } from "../server.ts";
import { LocalFileBackend } from "../logic/backends/local-file-backend.ts";
import type { TodoBackend } from "../logic/backend.ts";
import {
  DEFAULT_READYZ_RATE_LIMIT_PER_MIN,
  resolveReadyzRateLimitPerMin,
} from "../logic/readiness-config.ts";
import { createReadinessProbe } from "../logic/readiness.ts";
import type { Todo } from "../logic/todo.ts";

interface ReadyZError {
  jsonrpc?: string;
  error?: { code?: number; message?: string };
  id?: null;
}

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
    options: CreateAppOptions = {},
  ) {
    httpServer = createApp(backend, {
      authToken: "readyz-token-aaaaaaaaaaaaaaaaaaaaaaaa",
      ...options,
    }).listen(0, "127.0.0.1");
    await once(httpServer, "listening");
    const address = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  it("rate limits the 121st readiness probe while /healthz stays open", async () => {
    const filename = join(tempDir, "todo.txt");
    await writeFile(filename, "task one\n");
    await startApp(new LocalFileBackend(filename));

    for (let attempt = 0; attempt < 120; attempt += 1) {
      const response = await fetch(`${baseUrl}/readyz`);
      expect(response.status).toBe(200);
      await response.body?.cancel();
    }

    const limited = await fetch(`${baseUrl}/readyz`);
    expect(limited.status).toBe(429);
    const retryAfter = Number(limited.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(await limited.json() as ReadyZError).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Too many readiness requests." },
      id: null,
    });

    // Liveness is never rate limited.
    const health = await fetch(`${baseUrl}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
  });

  it("uses a limiter independent of /mcp and /metrics", async () => {
    const filename = join(tempDir, "todo.txt");
    const token = "readyz-token-aaaaaaaaaaaaaaaaaaaaaaaa";
    await writeFile(filename, "task one\n");
    await startApp(new LocalFileBackend(filename), {
      authToken: token,
      abuse: { rateLimitPerMin: 1, authFailLimit: 100 },
      metrics: { enabled: true, rateLimitPerMin: 1 },
      limits: { readyzRateLimitPerMin: 2 },
    });

    expect((await fetch(`${baseUrl}/readyz`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/readyz`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/readyz`)).status).toBe(429);
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);

    // Exhausting readiness did not consume the other buckets.
    const authorization = { authorization: `Bearer ${token}` };
    const mcp = await fetch(`${baseUrl}/mcp`, { headers: authorization });
    expect(mcp.status).toBe(405);
    await mcp.body?.cancel();
    const metrics = await fetch(`${baseUrl}/metrics`, {
      headers: authorization,
    });
    expect(metrics.status).toBe(200);
    await metrics.body?.cancel();
  });

  it("returns ready for a valid file while healthz stays cheap", async () => {
    const filename = join(tempDir, "todo.txt");
    await writeFile(filename, "task one\ntask two\n");

    await startApp(new LocalFileBackend(filename));

    // /readyz is unauthenticated even when /mcp requires a token.
    const ready = await fetch(`${baseUrl}/readyz`);
    expect(ready.status).toBe(200);
    expect(ready.headers.get("cross-origin-resource-policy")).toBe(
      "same-origin",
    );
    expect(ready.headers.get("content-security-policy")).toBe(
      "default-src 'none'",
    );
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
    expect(ready.headers.get("cross-origin-resource-policy")).toBe(
      "same-origin",
    );
    expect(ready.headers.get("content-security-policy")).toBe(
      "default-src 'none'",
    );
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

  it("reuses a timed-out load until the backend settles", async () => {
    let loads = 0;
    let release!: () => void;
    const backend: TodoBackend = {
      load: () => {
        loads += 1;
        if (loads > 1) {
          return Promise.resolve([]);
        }
        return new Promise<Todo[]>((resolve) => {
          release = () => resolve([]);
        });
      },
      save: async () => {},
    };
    const probe = createReadinessProbe(backend, 10);

    await expect(probe()).resolves.toMatchObject({ ready: false });
    await expect(probe()).resolves.toMatchObject({ ready: false });
    expect(loads).toBe(1);

    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(probe()).resolves.toEqual({ ready: true });
    expect(loads).toBe(2);
  });

  it("serves repeated HTTP probes from the readiness cache", async () => {
    let loads = 0;
    const backend: TodoBackend = {
      load: async () => {
        loads += 1;
        return [];
      },
      save: async () => {},
    };

    await startApp(backend, { readinessCacheMs: 60_000 });

    const first = await fetch(`${baseUrl}/readyz`);
    const second = await fetch(`${baseUrl}/readyz`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(loads).toBe(1);
  });

  it("reuses a successful result for cacheMs without a second backend load", async () => {
    let loads = 0;
    let clock = 1_000;
    const backend: TodoBackend = {
      load: async () => {
        loads += 1;
        return [];
      },
      save: async () => {},
    };
    const probe = createReadinessProbe(backend, 1_000, {
      cacheMs: 5_000,
      now: () => clock,
    });

    await expect(probe()).resolves.toEqual({ ready: true });
    clock += 4_999;
    await expect(probe()).resolves.toEqual({ ready: true });

    expect(loads).toBe(1);
  });

  it("probes again after the cached result expires", async () => {
    let loads = 0;
    let clock = 1_000;
    const backend: TodoBackend = {
      load: async () => {
        loads += 1;
        return [];
      },
      save: async () => {},
    };
    const probe = createReadinessProbe(backend, 1_000, {
      cacheMs: 5_000,
      now: () => clock,
    });

    await expect(probe()).resolves.toEqual({ ready: true });
    clock += 5_000;
    await expect(probe()).resolves.toEqual({ ready: true });

    expect(loads).toBe(2);
  });

  it("does not cache failures", async () => {
    let loads = 0;
    let clock = 1_000;
    const backend: TodoBackend = {
      load: async () => {
        loads += 1;
        if (loads === 1) {
          throw new Error("backend unavailable");
        }
        return [];
      },
      save: async () => {},
    };
    const probe = createReadinessProbe(backend, 1_000, {
      cacheMs: 5_000,
      now: () => clock,
    });

    await expect(probe()).resolves.toEqual({
      ready: false,
      reason: "backend unavailable",
    });
    await expect(probe()).resolves.toEqual({ ready: true });

    expect(loads).toBe(2);
  });

  it("does not cache a timed-out result even when caching is enabled", async () => {
    let loads = 0;
    let release!: () => void;
    const backend: TodoBackend = {
      load: () => {
        loads += 1;
        if (loads > 1) {
          return Promise.resolve([]);
        }
        return new Promise<Todo[]>((resolve) => {
          release = () => resolve([]);
        });
      },
      save: async () => {},
    };
    const probe = createReadinessProbe(backend, 10, { cacheMs: 5_000 });

    await expect(probe()).resolves.toMatchObject({ ready: false });
    await expect(probe()).resolves.toMatchObject({ ready: false });
    expect(loads).toBe(1);

    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(probe()).resolves.toEqual({ ready: true });
    expect(loads).toBe(2);
  });

  it("keeps single-flight behavior and serves the settled result from cache", async () => {
    let loads = 0;
    const backend: TodoBackend = {
      load: async () => {
        loads += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return [];
      },
      save: async () => {},
    };
    const probe = createReadinessProbe(backend, 1_000, { cacheMs: 5_000 });

    const results = await Promise.all([probe(), probe(), probe()]);

    expect(results).toEqual([{ ready: true }, { ready: true }, { ready: true }]);
    expect(loads).toBe(1);

    await expect(probe()).resolves.toEqual({ ready: true });
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

describe("readiness rate-limit configuration", () => {
  it("defaults to 120 probes per minute and accepts an override", () => {
    expect(DEFAULT_READYZ_RATE_LIMIT_PER_MIN).toBe(120);
    expect(resolveReadyzRateLimitPerMin(undefined, {})).toBe(120);
    expect(
      resolveReadyzRateLimitPerMin(undefined, {
        MCP_READYZ_RATE_LIMIT_PER_MIN: "30",
      }),
    ).toBe(30);
    expect(
      resolveReadyzRateLimitPerMin(undefined, {
        MCP_READYZ_RATE_LIMIT_PER_MIN: "0",
      }),
    ).toBe(0);
    expect(
      resolveReadyzRateLimitPerMin(undefined, {
        MCP_READYZ_RATE_LIMIT_PER_MIN: "",
      }),
    ).toBe(120);
    expect(resolveReadyzRateLimitPerMin(5, {})).toBe(5);
  });

  it("rejects invalid or negative values", () => {
    for (const value of ["-1", "1.5", "many", "-0.5"]) {
      expect(() =>
        resolveReadyzRateLimitPerMin(undefined, {
          MCP_READYZ_RATE_LIMIT_PER_MIN: value,
        })
      ).toThrow(/MCP_READYZ_RATE_LIMIT_PER_MIN/);
    }
    expect(() => resolveReadyzRateLimitPerMin(-1, {})).toThrow(
      /non-negative integer/,
    );
  });
});
