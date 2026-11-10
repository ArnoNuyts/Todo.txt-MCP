import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebDavBackend } from "../logic/backends/webdav-backend.ts";

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

  it("only inspects the first 1024 characters for document markers", async () => {
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
