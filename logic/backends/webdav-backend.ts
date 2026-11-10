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
const MAX_RETRY_AFTER_MS = 5_000;
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

/**
 * A todo file must be plain text. A proxy or login page can answer 200 with
 * HTML while echoing the origin's validators; parsing that as todos would
 * overwrite the real file on the next save.
 */
function mediaTypeOf(value: string | null): string | null {
  return value === null ? null : value.split(";")[0].trim().toLowerCase();
}

function isTodoContentType(value: string | null): boolean {
  const mediaType = mediaTypeOf(value);
  return mediaType === null ||
    mediaType === "" ||
    mediaType === "text/plain" ||
    mediaType === "application/octet-stream" ||
    mediaType === "binary/octet-stream";
}

const HTML_PROBE_LENGTH = 1024;
const BROAD_HTML_MARKER =
  /<!doctype\s+html|<html\b|<head\b|<body\b|<meta\b|<title\b|<script\b|<!--|<\?xml/i;
const DOCUMENT_HTML_MARKER =
  /<(?:head|body|title|meta|script|form)\b|<\/(?:html|head|body)\s*>/i;

/**
 * An error page is not a todo file. Without `text/plain` we can be strict and
 * reject any HTML/XML marker; with `text/plain` only document-level markers
 * are rejected, because a lone `<html>` token can legitimately be todo text.
 */
function looksLikeErrorPage(
  text: string,
  mediaType: string | null,
): boolean {
  const prefix = text.slice(0, HTML_PROBE_LENGTH);
  if (mediaType !== "text/plain") {
    return BROAD_HTML_MARKER.test(prefix);
  }
  const hasHtmlElement = /<html\b/i.test(prefix);
  return /<!doctype\s+html/i.test(prefix) ||
    /<\?xml/i.test(prefix) ||
    (hasHtmlElement && DOCUMENT_HTML_MARKER.test(prefix));
}

/** Servers may normalise EOLs or the trailing newline of the stored body. */
function hasSameTodoContent(left: string, right: string): boolean {
  const normalize = (value: string) =>
    value.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  return normalize(left) === normalize(right);
}

type WriteProbe =
  | { state: "applied"; revision: WebDavRevision }
  | { state: "not-applied" }
  | { state: "unknown" };

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
      // A redirect changes which resource is parsed as the todo file. Reads,
      // like writes, must describe the resource at the configured URL.
      redirect: "manual",
    });

    if (response.status >= 300 && response.status < 400) {
      await discardBody(response);
      throw new Error(
        `WebDAV load was redirected (${response.status} ${response.statusText}). ` +
          "Refusing to follow a redirect for a read.",
      );
    }

    if (!response.ok) {
      if (response.status === 404) {
        this.recordRevision({ exists: false });
        return [];
      }
      throw new Error(
        `Failed to load todos from WebDAV: ${response.status} ${response.statusText}`,
      );
    }

    const contentType = response.headers.get("Content-Type");
    if (!isTodoContentType(contentType)) {
      await discardBody(response);
      throw new Error(
        "Failed to load todos from WebDAV: expected a plain-text body but " +
          `received "${contentType}". The stored file was not modified.`,
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

    if (looksLikeErrorPage(text, mediaTypeOf(contentType))) {
      throw new Error(
        "Failed to load todos from WebDAV: the response looks like an HTML " +
          "error page, not a todo file. The stored file was not modified.",
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

  /**
   * Reads the stored body to decide whether a PUT whose response was lost was
   * applied. A server can commit the write and then fail, time out, or answer
   * 500; reporting that as a plain failure invites a duplicate retry.
   */
  private async probeWrite(content: string): Promise<WriteProbe> {
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "GET",
        headers: this.getHeaders(),
        // The probe must describe the stored resource, never a cache or a
        // redirect target.
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      return { state: "unknown" };
    }

    if (response.status === 404) {
      await discardBody(response);
      return { state: "not-applied" };
    }
    if (
      !response.ok ||
      !isTodoContentType(response.headers.get("Content-Type"))
    ) {
      await discardBody(response);
      return { state: "unknown" };
    }

    try {
      const contentLength = response.headers.get("Content-Length");
      if (
        contentLength !== null &&
        /^\d+$/.test(contentLength.trim()) &&
        Number(contentLength.trim()) > this.maxFileBytes
      ) {
        await discardBody(response);
        return { state: "unknown" };
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > this.maxFileBytes) {
        return { state: "unknown" };
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (!hasSameTodoContent(text, content)) {
        return { state: "not-applied" };
      }
      return {
        state: "applied",
        revision: {
          exists: true,
          etag: response.headers.get("ETag")?.trim() || undefined,
          lastModified: response.headers.get("Last-Modified")?.trim() ||
            undefined,
        },
      };
    } catch {
      return { state: "unknown" };
    }
  }

  private uncertainWriteError(): BackendConflictError {
    return new BackendConflictError(
      "WebDAV write outcome could not be confirmed: the server did not " +
        "acknowledge the PUT and the stored file could not be read back. " +
        "Reload with list_todos before retrying; the write may already have " +
        "been applied.",
      { backend: "webdav", reason: "outcome-unknown" },
    );
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

    /** Returns true when the PUT is confirmed to be applied. */
    const confirmApplied = async (): Promise<boolean> => {
      const probe = await this.probeWrite(content);
      if (probe.state === "applied") {
        context.revision = probe.revision;
        return true;
      }
      if (probe.state === "unknown") {
        throw this.uncertainWriteError();
      }
      return false;
    };

    let response: Response;
    try {
      response = await this.fetchWithRetry({
        method: "PUT",
        headers,
        body: content,
        // A redirected PUT must never be silently converted into a GET.
        redirect: "manual",
      });
    } catch (error) {
      if (await confirmApplied()) {
        return;
      }
      throw error;
    }

    if (response.status >= 300 && response.status < 400) {
      await discardBody(response);
      throw new Error(
        `WebDAV PUT was redirected (${response.status} ${response.statusText}). ` +
          "Refusing to follow a redirect for a write.",
      );
    }

    if (response.status === 412) {
      await discardBody(response);
      // The retries may have applied an earlier attempt, so a 412 is not
      // proof that nothing changed.
      if (await confirmApplied()) {
        return;
      }
      throw new BackendConflictError(
        "WebDAV conflict: the todo file was modified remotely " +
          "(412 Precondition Failed). Reload the todos and try again.",
        { backend: "webdav", status: 412 },
      );
    }

    if (!response.ok) {
      const status = response.status;
      const statusText = response.statusText;
      await discardBody(response);
      if (RETRYABLE_STATUSES.has(status) && await confirmApplied()) {
        return;
      }
      throw new Error(
        `Failed to save todos to WebDAV: ${status} ${statusText}`,
      );
    }

    // Keep the revision current for any further save in this transaction.
    // If the PUT returned a new Last-Modified but no ETag, the old ETag no
    // longer describes the stored revision: prefer the new date validator and
    // drop the stale strong validator.
    const newEtag = response.headers.get("ETag")?.trim() || undefined;
    const newLastModified =
      response.headers.get("Last-Modified")?.trim() || undefined;
    context.revision = {
      exists: true,
      etag: newEtag ??
        (newLastModified === undefined ? revision.etag : undefined),
      lastModified: newLastModified ?? revision.lastModified,
    };
  }
}

/** An ETag that is safe to use in `If-Match` (not weak, i.e. no `W/` prefix). */
function isStrongEtag(etag: string): boolean {
  return !/^W\//i.test(etag.trim());
}
