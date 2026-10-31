import type { TodoBackend } from "../backend.ts";
import { Todo } from "../todo.ts";
import { Todos } from "../Todos.ts";
import {
  assertFileSizeWithinLimit,
  resolveMaxFileBytes,
} from "../limits.ts";

const FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 100;
const DEFAULT_MAX_DELAY_MS = 5_000;
/** Upper bound for a server-provided Retry-After, to avoid indefinite waits. */
const MAX_RETRY_AFTER_MS = 60_000;
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Status codes worth retrying. Auth, missing and conflict responses are not. */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([
  408, // Request Timeout
  425, // Too Early
  429, // Too Many Requests
  500, // Internal Server Error
  502, // Bad Gateway
  503, // Service Unavailable
  504, // Gateway Timeout
]);

export interface WebDavBackendOptions {
  /** Maximum number of attempts per request (default: 3). */
  maxAttempts?: number;
  /** Base delay for jittered exponential backoff in milliseconds (default: 100). */
  baseDelayMs?: number;
  /** Maximum backoff delay in milliseconds (default: 5000). */
  maxDelayMs?: number;
  /** Random source in [0, 1), injectable for deterministic tests. */
  random?: () => number;
  /** Maximum allowed todo file size in bytes. Defaults to the env limit. */
  maxFileBytes?: number;
}

/**
 * Parses a `Retry-After` header value, which is either a number of seconds or
 * an HTTP date. Returns `undefined` when the value is absent or invalid.
 */
export function parseRetryAfterMs(
  value: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }

  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) {
    return undefined;
  }

  return Math.max(0, date - now);
}

/**
 * Computes the delay before the next attempt. A server-provided Retry-After
 * wins over backoff; otherwise the delay grows exponentially with jitter.
 */
export function computeRetryDelayMs(
  attempt: number,
  retryAfterMs: number | undefined,
  options: {
    baseDelayMs?: number;
    maxDelayMs?: number;
    random?: () => number;
  } = {},
): number {
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

  if (retryAfterMs !== undefined) {
    return Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
  }

  const random = options.random ?? Math.random;
  const exponential = Math.min(
    maxDelayMs,
    baseDelayMs * 2 ** Math.max(0, attempt - 1),
  );
  // "Equal jitter": keep half of the delay fixed and randomize the rest.
  return Math.round(exponential / 2 + random() * (exponential / 2));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function discardBody(response: Response): Promise<void> {
  if (response.body) {
    await response.body.cancel().catch(() => undefined);
  }
}

export class WebDavBackend implements TodoBackend {
  private readonly url: string;
  private readonly username?: string;
  private readonly password?: string;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly random: () => number;
  private readonly maxFileBytes: number;
  private etag: string | undefined;

  constructor(
    url: string,
    username?: string,
    password?: string,
    options: WebDavBackendOptions = {},
  ) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch (error) {
      throw new Error(`Invalid WebDAV URL "${url}".`, { cause: error });
    }

    const isLocal = LOCAL_HOSTNAMES.has(parsedUrl.hostname);
    if (parsedUrl.protocol !== "https:" && !isLocal) {
      throw new Error(
        `WebDAV URL must use https:// (got "${parsedUrl.protocol}//${parsedUrl.hostname}"). ` +
          "Plain http:// is only allowed for localhost, 127.0.0.1, or ::1.",
      );
    }

    this.url = url;
    this.username = username;
    this.password = password;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.random = options.random ?? Math.random;
    this.maxFileBytes = options.maxFileBytes ?? resolveMaxFileBytes();
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.username && this.password) {
      const encoded = Buffer.from(
        `${this.username}:${this.password}`,
      ).toString("base64");
      headers["Authorization"] = `Basic ${encoded}`;
    }
    return headers;
  }

  /**
   * Runs a request with retries on network errors and transient HTTP statuses.
   * Every attempt gets its own 10s timeout. Non-retryable responses (including
   * 401, 403, 404 and 412) are returned immediately to the caller.
   */
  private async fetchWithRetry(
    init: RequestInit,
  ): Promise<Response> {
    const maxAttempts = Math.max(1, this.maxAttempts);
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let response: Response;
      try {
        response = await fetch(this.url, {
          ...init,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
      } catch (error) {
        lastError = error;
        if (attempt >= maxAttempts) {
          break;
        }
        await sleep(computeRetryDelayMs(attempt, undefined, this.retryOptions()));
        continue;
      }

      if (
        response.ok ||
        !RETRYABLE_STATUSES.has(response.status) ||
        attempt >= maxAttempts
      ) {
        return response;
      }

      await discardBody(response);
      const retryAfterMs = parseRetryAfterMs(
        response.headers.get("Retry-After"),
      );
      await sleep(
        computeRetryDelayMs(attempt, retryAfterMs, this.retryOptions()),
      );
    }

    const message = lastError instanceof Error
      ? lastError.message
      : String(lastError);
    throw new Error(
      `WebDAV request failed after ${maxAttempts} attempts: ${message}`,
      { cause: lastError },
    );
  }

  private retryOptions() {
    return {
      baseDelayMs: this.baseDelayMs,
      maxDelayMs: this.maxDelayMs,
      random: this.random,
    };
  }

  async load(): Promise<Todo[]> {
    const response = await this.fetchWithRetry({
      method: "GET",
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      if (response.status === 404) {
        this.etag = undefined;
        return new Todos();
      }
      throw new Error(
        `Failed to load todos from WebDAV: ${response.status} ${response.statusText}`,
      );
    }

    this.etag = response.headers.get("ETag") ?? undefined;

    // Reject an obviously oversized file before reading the body.
    const contentLength = response.headers.get("Content-Length");
    if (contentLength !== null && /^\d+$/.test(contentLength.trim())) {
      assertFileSizeWithinLimit(
        "WebDAV todo file",
        Number(contentLength.trim()),
        this.maxFileBytes,
      );
    }

    const text = await response.text();
    assertFileSizeWithinLimit(
      "WebDAV todo file",
      Buffer.byteLength(text, "utf8"),
      this.maxFileBytes,
    );

    return new Todos(
      ...text
        .split("\n")
        .filter((x) => x.trim())
        .map((x) => new Todo(x)),
    );
  }

  async save(todos: Todo[]): Promise<void> {
    const content = todos.map((y) => y.toString()).join("\n") + "\n";
    const headers: Record<string, string> = {
      ...this.getHeaders(),
      "Content-Type": "text/plain",
    };
    if (this.etag) {
      headers["If-Match"] = this.etag;
    }

    const response = await this.fetchWithRetry({
      method: "PUT",
      headers,
      body: content,
    });

    if (response.status === 412) {
      throw new Error(
        "WebDAV conflict: the todo file was modified remotely " +
          "(412 Precondition Failed). Reload the todos and try again.",
      );
    }

    if (!response.ok) {
      throw new Error(
        `Failed to save todos to WebDAV: ${response.status} ${response.statusText}`,
      );
    }

    this.etag = response.headers.get("ETag") ?? this.etag;
  }
}
