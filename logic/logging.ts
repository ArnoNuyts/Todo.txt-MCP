import { randomUUID } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";

/**
 * Minimal structured logging.
 *
 * Every record is a single JSON line. `debug`/`info` go to stdout and
 * `warn`/`error` to stderr so container and log collectors can separate
 * operational warnings from normal traffic. Request logging deliberately
 * records only metadata: never Authorization headers, tokens, bodies, or todo
 * content.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function resolveLogLevel(env: NodeJS.ProcessEnv = process.env): LogLevel {
  const value = env.MCP_LOG_LEVEL?.trim().toLowerCase();
  switch (value) {
    case "debug":
    case "info":
    case "warn":
    case "error":
      return value;
    default:
      return "info";
  }
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Sink for debug/info lines. Defaults to stdout. */
  stdout?: (line: string) => void;
  /** Sink for warn/error lines. Defaults to stderr. */
  stderr?: (line: string) => void;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

export type LogFields = Record<string, unknown>;

export interface Logger {
  readonly level: LogLevel;
  isEnabled(level: LogLevel): boolean;
  log(level: LogLevel, msg: string, fields?: LogFields): void;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const stdout = options.stdout ??
    ((line: string) => process.stdout.write(`${line}\n`));
  const stderr = options.stderr ??
    ((line: string) => process.stderr.write(`${line}\n`));
  const now = options.now ?? (() => new Date());

  const emit = (entryLevel: LogLevel, msg: string, fields: LogFields = {}) => {
    if (LEVEL_PRIORITY[entryLevel] < LEVEL_PRIORITY[level]) {
      return;
    }
    const record = {
      ...fields,
      ts: now().toISOString(),
      level: entryLevel,
      msg,
    };
    const line = JSON.stringify(record);
    if (entryLevel === "warn" || entryLevel === "error") {
      stderr(line);
    } else {
      stdout(line);
    }
  };

  return {
    level,
    isEnabled: (entryLevel) =>
      LEVEL_PRIORITY[entryLevel] >= LEVEL_PRIORITY[level],
    log: emit,
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
  };
}

/** Request IDs are bounded ASCII tokens so they are safe to log and echo. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Returns a valid incoming request ID or a fresh UUID. Arrays and malformed
 * values are ignored rather than trusted.
 */
export function normalizeRequestId(value: unknown): string {
  if (typeof value === "string" && REQUEST_ID_PATTERN.test(value)) {
    return value;
  }
  if (
    Array.isArray(value) && value.length === 1 &&
    typeof value[0] === "string" && REQUEST_ID_PATTERN.test(value[0])
  ) {
    return value[0];
  }
  return randomUUID();
}

type RequestWithId = Request & { id?: string };

export interface RequestLoggingOptions {
  now?: () => number;
}

/**
 * Assigns `req.id`, echoes it as `X-Request-ID`, and logs one line when the
 * response finishes. Must run after `trust proxy` is configured so `req.ip`
 * reflects the client address.
 */
export function createRequestLoggingMiddleware(
  logger: Logger,
  options: RequestLoggingOptions = {},
): RequestHandler {
  const now = options.now ?? (() => Date.now());

  return (req: Request, res: Response, next) => {
    const requestId = normalizeRequestId(req.headers["x-request-id"]);
    (req as RequestWithId).id = requestId;
    res.locals.requestId = requestId;
    res.setHeader("X-Request-ID", requestId);

    const startedAt = now();
    // Capture the path now: Express rewrites `req.url` while routing, so
    // reading it on `finish` can yield "/" instead of the requested path.
    const path = getRequestPath(req);
    res.once("finish", () => {
      const authResult = res.locals.authResult === "ok" ||
          res.locals.authResult === "fail"
        ? res.locals.authResult
        : "none";
      logger.info("request", {
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.max(0, now() - startedAt),
        ip: req.ip ?? "unknown",
        auth: authResult,
      });
    });

    next();
  };
}

/** Reads the request ID assigned by {@link createRequestLoggingMiddleware}. */
export function getRequestId(req: Request): string | undefined {
  return (req as RequestWithId).id;
}

/** Returns the request path without the query string or mount rewriting. */
export function getRequestPath(req: Request): string {
  const original = req.originalUrl ?? req.url;
  const queryIndex = original.indexOf("?");
  return queryIndex === -1 ? original : original.slice(0, queryIndex);
}
