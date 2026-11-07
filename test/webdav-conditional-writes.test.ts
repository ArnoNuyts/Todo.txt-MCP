import { afterEach, describe, expect, it, vi } from "vitest";
import { WebDavBackend } from "../logic/backends/webdav-backend.ts";
import { BackendConflictError } from "../logic/backend-errors.ts";
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

function putHeaders(call: unknown[]): Record<string, string> {
  return (call[1] as RequestInit).headers as Record<string, string>;
}

describe("WebDavBackend conditional writes", () => {
  it("sends a strong ETag as If-Match on save", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response("old\n", 200, { ETag: '"v1"' }))
      .mockResolvedValueOnce(response("", 201, { ETag: '"v2"' }));
    vi.stubGlobal("fetch", fetchMock);

    const backend = new WebDavBackend(url, undefined, undefined, fastRetry);
    await backend.withLock(async () => {
      await backend.load();
      await backend.save([new Todo("new")]);
    });

    expect(putHeaders(fetchMock.mock.calls[1])).toMatchObject({
      "If-Match": '"v1"',
    });
    expect(putHeaders(fetchMock.mock.calls[1])).not.toHaveProperty(
      "If-None-Match",
    );
  });

  it("updates the revision from a successful PUT", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response("old\n", 200, { ETag: '"v1"' }))
      .mockResolvedValueOnce(response("", 201, { ETag: '"v2"' }))
      .mockResolvedValueOnce(response("", 200, { ETag: '"v3"' }));
    vi.stubGlobal("fetch", fetchMock);

    const backend = new WebDavBackend(url, undefined, undefined, fastRetry);
    await backend.withLock(async () => {
      await backend.load();
      await backend.save([new Todo("first")]);
      await backend.save([new Todo("second")]);
    });

    expect(putHeaders(fetchMock.mock.calls[1])).toMatchObject({
      "If-Match": '"v1"',
    });
    expect(putHeaders(fetchMock.mock.calls[2])).toMatchObject({
      "If-Match": '"v2"',
    });
  });

  it("keeps the transaction revision during a concurrent load", async () => {
    let serverContent = "original\n";
    let serverEtag = '"v1"';
    const sentPutHeaders: Array<Record<string, string>> = [];

    let releaseFirstGet!: () => void;
    let firstGetStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirstGet = resolve;
    });
    const started = new Promise<void>((resolve) => {
      firstGetStarted = resolve;
    });

    let getCount = 0;
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        getCount += 1;
        if (getCount === 1) {
          // The first GET (the add's load) sees the original revision, but its
          // body is held while an external client commits a newer revision.
          const snapshotContent = serverContent;
          const snapshotEtag = serverEtag;
          firstGetStarted();
          await gate;
          return response(snapshotContent, 200, { ETag: snapshotEtag });
        }
        return response(serverContent, 200, { ETag: serverEtag });
      }

      const headers = init?.headers as Record<string, string>;
      sentPutHeaders.push(headers);
      if (
        headers["If-Match"] !== undefined &&
        headers["If-Match"] !== serverEtag
      ) {
        return response("", 412);
      }
      serverContent = String(init?.body ?? "");
      serverEtag = '"v3"';
      return response("", 201, { ETag: serverEtag });
    });
    vi.stubGlobal("fetch", fetchMock);

    const backend = new WebDavBackend(url, undefined, undefined, fastRetry);
    const add = backend.withLock(async () => {
      const todos = await backend.load();
      todos.push(new Todo("added"));
      await backend.save(todos);
    });

    await started;
    // External client commits a newer revision between the add's GET and PUT.
    serverContent = "external\n";
    serverEtag = '"v2"';

    // A concurrent read outside the add's transaction must not replace the
    // revision the add captured.
    const concurrent = await backend.load();
    expect(concurrent.map((todo) => todo.toString())).toEqual(["external"]);

    releaseFirstGet();

    await expect(add).rejects.toBeInstanceOf(BackendConflictError);
    expect(sentPutHeaders).toHaveLength(1);
    expect(sentPutHeaders[0]).toMatchObject({ "If-Match": '"v1"' });
    expect(serverContent).toBe("external\n");
  });

  it("uses If-None-Match: * after a 404 and reports a create conflict", async () => {
    const sentPutHeaders: Array<Record<string, string>> = [];
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        return response("", 404);
      }
      sentPutHeaders.push(init?.headers as Record<string, string>);
      return response("", 412);
    });
    vi.stubGlobal("fetch", fetchMock);

    const backend = new WebDavBackend(url, undefined, undefined, fastRetry);
    await expect(
      backend.withLock(async () => {
        await backend.load();
        await backend.save([new Todo("task")]);
      }),
    ).rejects.toBeInstanceOf(BackendConflictError);

    expect(sentPutHeaders).toHaveLength(1);
    expect(sentPutHeaders[0]).toMatchObject({ "If-None-Match": "*" });
    expect(sentPutHeaders[0]).not.toHaveProperty("If-Match");
  });

  it("uses If-Unmodified-Since when the ETag is missing", async () => {
    const lastModified = "Wed, 01 Jan 2025 00:00:00 GMT";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        response("old\n", 200, { "Last-Modified": lastModified }),
      )
      .mockResolvedValueOnce(response("", 201));
    vi.stubGlobal("fetch", fetchMock);

    const backend = new WebDavBackend(url, undefined, undefined, fastRetry);
    await backend.withLock(async () => {
      await backend.load();
      await backend.save([new Todo("new")]);
    });

    const headers = putHeaders(fetchMock.mock.calls[1]);
    expect(headers).toMatchObject({ "If-Unmodified-Since": lastModified });
    expect(headers).not.toHaveProperty("If-Match");
  });

  it("refuses to save when there is no ETag or Last-Modified", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response("old\n", 200))
      .mockResolvedValueOnce(response("", 201));
    vi.stubGlobal("fetch", fetchMock);

    const backend = new WebDavBackend(url, undefined, undefined, fastRetry);
    await expect(
      backend.withLock(async () => {
        await backend.load();
        await backend.save([new Todo("new")]);
      }),
    ).rejects.toThrow(/usable validator/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("GET");
  });

  it("does not send a weak ETag as If-Match and falls back to If-Unmodified-Since", async () => {
    const lastModified = "Wed, 01 Jan 2025 00:00:00 GMT";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        response("old\n", 200, {
          ETag: 'W/"v1"',
          "Last-Modified": lastModified,
        }),
      )
      .mockResolvedValueOnce(response("", 201));
    vi.stubGlobal("fetch", fetchMock);

    const backend = new WebDavBackend(url, undefined, undefined, fastRetry);
    await backend.withLock(async () => {
      await backend.load();
      await backend.save([new Todo("new")]);
    });

    const headers = putHeaders(fetchMock.mock.calls[1]);
    expect(headers).not.toHaveProperty("If-Match");
    expect(headers).toMatchObject({ "If-Unmodified-Since": lastModified });
  });

  it("refuses a weak ETag without Last-Modified", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response("old\n", 200, { ETag: 'W/"v1"' }))
      .mockResolvedValueOnce(response("", 201));
    vi.stubGlobal("fetch", fetchMock);

    const backend = new WebDavBackend(url, undefined, undefined, fastRetry);
    await expect(
      backend.withLock(async () => {
        await backend.load();
        await backend.save([new Todo("new")]);
      }),
    ).rejects.toThrow(/weak ETag.*no Last-Modified/i);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a redirected PUT without following it", async () => {
    let serverContent = "original\n";
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        return response(serverContent, 200, { ETag: '"v1"' });
      }
      return response("", 303, { Location: "https://elsewhere.example/todo" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const backend = new WebDavBackend(url, undefined, undefined, fastRetry);
    await expect(
      backend.withLock(async () => {
        await backend.load();
        await backend.save([new Todo("new")]);
      }),
    ).rejects.toThrow(/redirected \(303/);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1][1] as RequestInit).redirect).toBe(
      "manual",
    );
    expect(serverContent).toBe("original\n");
  });

  it("rejects an oversized write before sending the PUT", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response("", 200, { ETag: '"v1"' }))
      .mockResolvedValueOnce(response("", 201));
    vi.stubGlobal("fetch", fetchMock);

    const backend = new WebDavBackend(url, undefined, undefined, {
      ...fastRetry,
      maxFileBytes: 16,
    });
    await expect(
      backend.withLock(async () => {
        await backend.load();
        await backend.save([new Todo("this task is much too large")]);
      }),
    ).rejects.toThrow(/too large/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("GET");
  });

  it("rejects invalid UTF-8 and never rewrites the remote file", async () => {
    const remoteBytes = new Uint8Array([0x74, 0xff, 0x0a]);
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      response(remoteBytes, 200, { ETag: '"v1"' })
    );
    vi.stubGlobal("fetch", fetchMock);

    const backend = new WebDavBackend(url, undefined, undefined, fastRetry);
    await expect(
      backend.withLock(async () => {
        const todos = await backend.load();
        todos.push(new Todo("added"));
        await backend.save(todos);
      }),
    ).rejects.toThrow(/not valid UTF-8/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("GET");
    expect([...remoteBytes]).toEqual([0x74, 0xff, 0x0a]);
  });
});

describe("WebDavBackend credential handling", () => {
  it("rejects URL-embedded credentials without leaking them", () => {
    const password = "super-secret-password";
    let message = "";
    try {
      new WebDavBackend(
        `https://alice:${password}@dav.example.com/todo.txt`,
      );
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toMatch(/must not contain credentials/);
    expect(message).not.toContain(password);
    expect(message).not.toContain("alice");
  });

  it("does not echo credentials from an invalid URL", () => {
    const password = "super-secret-password";
    let message = "";
    try {
      new WebDavBackend(`https://alice:${password}@`);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toMatch(/Invalid WebDAV URL/);
    expect(message).not.toContain(password);
    expect(message).not.toContain("alice");
  });
});
