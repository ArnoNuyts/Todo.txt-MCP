import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebDavBackend } from "../logic/backends/webdav-backend.ts";
import { Todo } from "../logic/todo.ts";

const url = "https://dav.example.com/todo.txt";
/** Disable retries and real backoff delays in tests. */
const fastRetry = { baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 1 };

afterEach(() => {
  vi.unstubAllGlobals();
});

function response(
  body: ConstructorParameters<typeof Response>[0],
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers });
}

describe("F3: WebDAV load does not follow redirects", () => {
  it("requests the load with redirect: manual", async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      response("task\n", 200)
    );
    vi.stubGlobal("fetch", fetchMock);

    await new WebDavBackend(url, undefined, undefined, fastRetry).load();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1] as RequestInit).toMatchObject({
      method: "GET",
      redirect: "manual",
    });
  });

  it.each([301, 302, 303, 307, 308])(
    "rejects a %i response instead of parsing the redirect target",
    async (status) => {
      const fetchMock = vi.fn(async () =>
        response("redirect target body\n", status, {
          Location: "https://elsewhere.example/todo.txt",
        })
      );
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        new WebDavBackend(url, undefined, undefined, fastRetry).load(),
      ).rejects.toThrow(/redirect/i);
    },
  );

  it("does not fetch a real loopback redirect target", async () => {
    let targetRequests = 0;
    const server = createServer((request, result) => {
      if (request.url === "/todo.txt") {
        result.writeHead(302, { Location: "/elsewhere.txt" });
        result.end();
        return;
      }
      targetRequests += 1;
      result.writeHead(200, { "Content-Type": "text/plain" });
      result.end("redirect target must not be parsed\n");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );

    try {
      const { port } = server.address() as AddressInfo;
      const backend = new WebDavBackend(
        `http://127.0.0.1:${port}/todo.txt`,
        undefined,
        undefined,
        fastRetry,
      );

      await expect(backend.load()).rejects.toThrow(/redirect/i);
      expect(targetRequests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});

describe("F9: full error pages mislabeled text/plain", () => {
  it.each([
    {
      name: "an HTML doctype",
      contentType: "text/plain",
      body: "<!doctype html><html><body>login</body></html>\n",
    },
    {
      name: "an HTML document with head and body",
      contentType: "text/plain; charset=utf-8",
      body:
        "<html><head><title>Login</title></head><body>sign in</body></html>\n",
    },
    {
      name: "an XML declaration",
      contentType: "text/plain",
      body: '<?xml version="1.0"?><error>login</error>\n',
    },
  ])("rejects $name served as $contentType", async ({
    contentType,
    body,
  }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(body, 200, { "Content-Type": contentType })),
    );

    await expect(
      new WebDavBackend(url, undefined, undefined, fastRetry).load(),
    ).rejects.toThrow(/HTML error page/);
  });

  it.each([
    "<html>login</html>\n",
    "<html><title>Login</title></html>\n",
    "<html><form action=\"/login\"></form></html>\n",
  ])("rejects a minimal document served as text/plain: %s", async (body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response(body, 200, { "Content-Type": "text/plain" })),
    );

    await expect(
      new WebDavBackend(url, undefined, undefined, fastRetry).load(),
    ).rejects.toThrow(/HTML error page/);
  });

  it("still accepts a single HTML tag in a text/plain todo", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response("<html> is a tag\n", 200, { "Content-Type": "text/plain" })
      ),
    );

    await expect(
      new WebDavBackend(url, undefined, undefined, fastRetry).load(),
    ).resolves.toHaveLength(1);
  });

  // Known limitation: widening the scan window is an improvement, not a
  // regression. This test pins the current bound so the cost stays explicit.
  it("documents the 1024-character detection bound", async () => {
    const body = `${"x".repeat(1024)}\n` +
      "<!doctype html><html><body>late error</body></html>\n";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response(body, 200, { "Content-Type": "text/plain" })),
    );

    const todos = await new WebDavBackend(url, undefined, undefined, fastRetry)
      .load();

    expect(todos).toHaveLength(2);
  });
});

describe("D5: shared body reader for load and write-probe", () => {
  /** Simulates a lost PUT (500) followed by a read-back with `probeBody`. */
  async function saveWithProbe(
    probeBody: () => Response,
    maxFileBytes?: number,
  ): Promise<void> {
    let getCount = 0;
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        getCount += 1;
        if (getCount === 1) {
          return response("old\n", 200, {
            "Content-Type": "text/plain",
            ETag: '"v1"',
          });
        }
        return probeBody();
      }
      return response("", 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    const backend = new WebDavBackend(url, undefined, undefined, {
      ...fastRetry,
      ...(maxFileBytes === undefined ? {} : { maxFileBytes }),
    });
    let error: unknown;
    try {
      await backend.withLock(async () => {
        await backend.load();
        await backend.save([new Todo("new")]);
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      name: "BackendConflictError",
      details: { backend: "webdav", reason: "outcome-unknown" },
    });
    expect((error as Error).message).toMatch(/could not be confirmed/);
  }

  it("treats an HTML error page read-back as an unknown outcome", async () => {
    await saveWithProbe(() =>
      response(
        "<!doctype html><html><body>login</body></html>\n",
        200,
        { "Content-Type": "text/plain" },
      )
    );
  });

  it("treats a non-text read-back content type as unknown", async () => {
    await saveWithProbe(() =>
      response("new\n", 200, { "Content-Type": "text/html" })
    );
  });

  it("rejects a streaming body over the limit without Content-Length", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8));
        controller.enqueue(new Uint8Array(8));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(body, { status: 200, headers: { "Content-Type": "text/plain" } })
    ));

    await expect(
      new WebDavBackend(url, undefined, undefined, {
        ...fastRetry,
        maxFileBytes: 10,
      }).load(),
    ).rejects.toThrow(/too large/);
  });

  it("treats a chunked read-back over the limit as unknown", async () => {
    await saveWithProbe(() => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(8));
          controller.enqueue(new Uint8Array(8));
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }, 10);
  });

  it("treats a read-back body over the byte limit as unknown", async () => {
    await saveWithProbe(
      () => response("x".repeat(64), 200, { "Content-Type": "text/plain" }),
      10,
    );
  });

  it("rejects an oversized Content-Length before reading the probe body", async () => {
    await saveWithProbe(
      () =>
        response("x", 200, {
          "Content-Type": "text/plain",
          "Content-Length": "999",
        }),
      10,
    );
  });

  it("treats invalid UTF-8 in the read-back as unknown", async () => {
    await saveWithProbe(
      () => response(new Uint8Array([0xff]), 200, {
        "Content-Type": "text/plain",
      }),
    );
  });

  it("accepts a missing Content-Type when the read-back matches", async () => {
    let getCount = 0;
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        getCount += 1;
        if (getCount === 1) {
          return response("old\n", 200, {
            "Content-Type": "text/plain",
            ETag: '"v1"',
          });
        }
        return response("new\n", 200);
      }
      return response("", 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    const backend = new WebDavBackend(url, undefined, undefined, fastRetry);

    await expect(
      backend.withLock(async () => {
        await backend.load();
        await backend.save([new Todo("new")]);
      }),
    ).resolves.toBeUndefined();
  });
});
