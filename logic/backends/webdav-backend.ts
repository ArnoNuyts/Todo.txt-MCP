import { AsyncLocalStorage } from "node:async_hooks";
import type { TodoBackend } from "../backend.ts";
import { Todo } from "../todo.ts";
import { serializeTodoContent } from "../content.ts";
import { BackendConflictError } from "../backend-errors.ts";
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
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([
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
 * Revision observed by a load. It is scoped to a single load -> save
 * transaction so a concurrent load in another transaction cannot replace it.
 */
interface WebDavRevision {
  exists: boolean;
  etag?: string;
  lastModified?: string;
}

interface RevisionContext {
  revision?: WebDavRevision;
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
  /**
   * Holds the revision for one load -> save transaction. `withLock` creates a
   * fresh context per mutation, so concurrent reads in other contexts cannot
   * clobber the revision used by an in-flight write.
   */
  private readonly revisionStorage = new AsyncLocalStorage<RevisionContext>();

  constructor(
    url: string,
    username?: string,
    password?: string,
    options: WebDavBackendOptions = {},
  ) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      // Do not include the input: it may contain credentials.
      throw new Error("Invalid WebDAV URL.");
    }

    if (parsedUrl.username !== "" || parsedUrl.password !== "") {
      throw new Error(
        "WebDAV URL must not contain credentials. Set " +
          "TODOTXT_MCP_WEBDAV_USERNAME and TODOTXT_MCP_WEBDAV_PASSWORD instead.",
      );
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

  /**
   * Runs a load -> mutate -> save cycle in its own revision context.
   * `withBackendLock` calls this for every mutation, isolating the revision
   * captured by `load` from concurrent reads.
   */
  withLock<T>(work: () => Promise<T>): Promise<T> {
    return this.revisionStorage.run({}, work);
  }

  private recordRevision(revision: WebDavRevision): void {
    const context = this.revisionStorage.getStore();
    if (context) {
      context.revision = revision;
    }
  }

  async load(): Promise<Todo[]> {
    const response = await this.fetchWithRetry({
      method: "GET",
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      if (response.status === 404) {
        this.recordRevision({ exists: false });
        return [];
      }
      throw new Error(
        `Failed to load todos from WebDAV: ${response.status} ${response.statusText}`,
      );
    }

    const etag = response.headers.get("ETag")?.trim() || undefined;
    const lastModified =
      response.headers.get("Last-Modified")?.trim() || undefined;

    // Reject an obviously oversized file before reading the body.
    const contentLength = response.headers.get("Content-Length");
    if (contentLength !== null && /^\d+$/.test(contentLength.trim())) {
      assertFileSizeWithinLimit(
        "WebDAV todo file",
        Number(contentLength.trim()),
        this.maxFileBytes,
      );
    }

    const bytes = await response.arrayBuffer();
    assertFileSizeWithinLimit(
      "WebDAV todo file",
      bytes.byteLength,
      this.maxFileBytes,
    );

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(
        "WebDAV todo file is not valid UTF-8. Refusing to load or rewrite it.",
      );
    }

    // Only record the revision after the body was read successfully, so a
    // failed load can never be turned into a write in the same transaction.
    this.recordRevision({ exists: true, etag, lastModified });

    return text
      .split("\n")
      .filter((x) => x.trim())
      .map((x) => new Todo(x));
  }

  async save(todos: Todo[]): Promise<void> {
    const context = this.revisionStorage.getStore();
    const revision = context?.revision;
    if (!context || revision === undefined) {
      throw new BackendConflictError(
        "WebDAV save requires a preceding load in the same transaction. " +
          "Refusing to send an unconditional PUT.",
        { backend: "webdav" },
      );
    }

    const content = serializeTodoContent(todos);
    assertFileSizeWithinLimit(
      "WebDAV todo file",
      Buffer.byteLength(content, "utf8"),
      this.maxFileBytes,
    );

    const headers: Record<string, string> = {
      ...this.getHeaders(),
      "Content-Type": "text/plain",
    };

    if (!revision.exists) {
      // The load saw a missing file: only create if it is still missing.
      headers["If-None-Match"] = "*";
    } else if (revision.etag !== undefined && isStrongEtag(revision.etag)) {
      headers["If-Match"] = revision.etag.trim();
    } else if (revision.lastModified !== undefined) {
      // A weak ETag must not be sent as If-Match, but the date still guards
      // the write against a modification since the load.
      headers["If-Unmodified-Since"] = revision.lastModified;
    } else {
      throw new BackendConflictError(
        revision.etag === undefined
          ? "WebDAV server did not provide an ETag or Last-Modified header, " +
              "so the write cannot be made conditional. Refusing to overwrite " +
              "the file without a usable validator."
          : "WebDAV server provided only a weak ETag and no Last-Modified " +
              "header, so the write cannot be made conditional. Refusing to " +
              "overwrite the file without a usable validator.",
        { backend: "webdav" },
      );
    }

    const response = await this.fetchWithRetry({
      method: "PUT",
      headers,
      body: content,
      // A redirected PUT must never be silently converted into a GET.
      redirect: "manual",
    });

    if (response.status >= 300 && response.status < 400) {
      await discardBody(response);
      throw new Error(
        `WebDAV PUT was redirected (${response.status} ${response.statusText}). ` +
          "Refusing to follow a redirect for a write.",
      );
    }

    if (response.status === 412) {
      throw new BackendConflictError(
        "WebDAV conflict: the todo file was modified remotely " +
          "(412 Precondition Failed). Reload the todos and try again.",
        { backend: "webdav", status: 412 },
      );
    }

    if (!response.ok) {
      throw new Error(
        `Failed to save todos to WebDAV: ${response.status} ${response.statusText}`,
      );
    }

    // Keep the revision current for any further save in this transaction.
    context.revision = {
      exists: true,
      etag: response.headers.get("ETag")?.trim() || revision.etag,
      lastModified:
        response.headers.get("Last-Modified")?.trim() || revision.lastModified,
    };
  }
}

/** An ETag that is safe to use in `If-Match` (not weak, i.e. no `W/` prefix). */
function isStrongEtag(etag: string): boolean {
  return !/^W\//i.test(etag.trim());
}
