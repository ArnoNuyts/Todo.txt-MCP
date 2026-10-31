import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeRetryDelayMs,
  parseRetryAfterMs,
  WebDavBackend,
} from "../logic/backends/webdav-backend.ts";
import { Todo } from "../logic/todo.ts";

const url = "https://dav.example.com/todo.txt";
/** Disable real backoff delays in tests. */
const fastRetry = { baseDelayMs: 0, maxDelayMs: 0 };

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(
  body: string,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers });
}

describe("WebDavBackend retry policy", () => {
  it("retries a GET after a transient 503 and then succeeds", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse("", 503))
      .mockResolvedValueOnce(jsonResponse("retried task\n", 200));
    vi.stubGlobal("fetch", fetchMock);

    const todos = await new WebDavBackend(url, undefined, undefined, fastRetry)
      .load();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect([...todos].map((todo) => todo.toString())).toEqual([
      "retried task",
    ]);
  });

  it("retries a PUT after a transient 500 and then succeeds", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse("", 500))
      .mockResolvedValueOnce(jsonResponse("", 201));
    vi.stubGlobal("fetch", fetchMock);

    await new WebDavBackend(url, undefined, undefined, fastRetry)
      .save([new Todo("task")]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops after three attempts when a status stays transient", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse("", 500, { "Status-Text": "Oops" })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new WebDavBackend(url, undefined, undefined, fastRetry).load(),
    ).rejects.toThrow("Failed to load todos from WebDAV: 500");

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries network errors and reports the final failure", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("network down");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new WebDavBackend(url, undefined, undefined, fastRetry).load(),
    ).rejects.toThrow(/after 3 attempts.*network down/);

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([401, 403, 404, 412])(
    "does not retry status %i",
    async (status) => {
      const fetchMock = vi.fn(async () => jsonResponse("", status));
      vi.stubGlobal("fetch", fetchMock);

      const backend = new WebDavBackend(url, undefined, undefined, fastRetry);
      if (status === 404) {
        await expect(backend.load()).resolves.toHaveLength(0);
      } else {
        await expect(backend.load()).rejects.toThrow(String(status));
      }

      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps a 412 save conflict clear and does not overwrite", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse("old\n", 200, { ETag: '"v1"' }))
      .mockResolvedValueOnce(jsonResponse("", 412));
    vi.stubGlobal("fetch", fetchMock);

    const backend = new WebDavBackend(url, undefined, undefined, fastRetry);
    await backend.load();

    await expect(backend.save([new Todo("new")])).rejects.toThrow(
      /conflict.*412/i,
    );
    // Only the GET and the single conflicting PUT were issued.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honors Retry-After instead of exponential backoff", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse("", 429, { "Retry-After": "0" }))
      .mockResolvedValueOnce(jsonResponse("", 200));
    vi.stubGlobal("fetch", fetchMock);

    const todos = await new WebDavBackend(url, undefined, undefined, fastRetry)
      .load();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(todos).toHaveLength(0);
  });

  it("uses a fresh 10s timeout signal for every attempt", async () => {
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.signal) {
        signals.push(init.signal);
      }
      return signals.length === 1
        ? jsonResponse("", 503)
        : jsonResponse("", 200);
    });
    vi.stubGlobal("fetch", fetchMock);

    await new WebDavBackend(url, undefined, undefined, fastRetry).load();

    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
  });
});

describe("retry helpers", () => {
  it("parses Retry-After seconds", () => {
    expect(parseRetryAfterMs("0")).toBe(0);
    expect(parseRetryAfterMs("2")).toBe(2000);
    expect(parseRetryAfterMs(" 15 ")).toBe(15_000);
  });

  it("parses Retry-After HTTP dates relative to now", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(
      parseRetryAfterMs("Thu, 01 Jan 2026 00:00:03 GMT", now),
    ).toBe(3000);
    expect(
      parseRetryAfterMs("Thu, 01 Jan 2020 00:00:00 GMT", now),
    ).toBe(0);
  });

  it("ignores absent or invalid Retry-After values", () => {
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs("")).toBeUndefined();
    expect(parseRetryAfterMs("soon")).toBeUndefined();
  });

  it("applies jittered exponential backoff", () => {
    // Half of the delay is fixed, the rest is jittered.
    expect(computeRetryDelayMs(1, undefined, {
      baseDelayMs: 100,
      maxDelayMs: 10_000,
      random: () => 0,
    })).toBe(50);
    expect(computeRetryDelayMs(1, undefined, {
      baseDelayMs: 100,
      maxDelayMs: 10_000,
      random: () => 1,
    })).toBe(100);
    expect(computeRetryDelayMs(2, undefined, {
      baseDelayMs: 100,
      maxDelayMs: 10_000,
      random: () => 0,
    })).toBe(100);
    expect(computeRetryDelayMs(3, undefined, {
      baseDelayMs: 100,
      maxDelayMs: 10_000,
      random: () => 1,
    })).toBe(400);
  });

  it("caps the backoff and Retry-After delays", () => {
    expect(computeRetryDelayMs(10, undefined, {
      baseDelayMs: 100,
      maxDelayMs: 5_000,
      random: () => 1,
    })).toBe(5_000);
    expect(computeRetryDelayMs(1, 120_000, { baseDelayMs: 100 })).toBe(60_000);
  });
});
