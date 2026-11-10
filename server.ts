import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import cors from "cors";
import type { Readable, Writable } from "node:stream";

import {
  buildCorsOptions,
  createBearerAuthMiddleware,
  DEFAULT_HOST,
  isLoopbackHost,
  parseTrustProxy,
  type HttpSecurityOptions,
  resolveHttpSecurityOptions,
  warnOnProxyPosture,
} from "./logic/http-security.ts";
import {
  type AbuseControlOverrides,
  createAbuseControls,
  resolveAbuseConfig,
  SlidingWindowLimiter,
} from "./logic/abuse-controls.ts";
import {
  assertAuthTokensConfigured,
  assertStrongAuthTokens,
  type AuthTokenOrigin,
  createAuthTokenStore,
  isWeakTokenOverrideEnabled,
  readAuthTokenFile,
  resolveAuthTokens,
  warnOnInsecureTokenFile,
} from "./logic/auth-tokens.ts";
import {
  assertStrongMetricsToken,
  type MetricsOverrides,
  type ResolvedMetricsConfig,
  resolveMetricsConfig,
} from "./logic/metrics-config.ts";
import { logSecurityPosture } from "./logic/security-posture.ts";
import {
  createLogger,
  createRequestLoggingMiddleware,
  getRequestId,
  getRequestPath,
  type Logger,
  type LogLevel,
  resolveLogLevel,
} from "./logic/logging.ts";
import { createMetrics } from "./logic/metrics.ts";
import {
  createOperationTracker,
  type OperationTracker,
} from "./logic/operation-tracker.ts";
import { resolveTransportMode, type TransportMode } from "./logic/transport.ts";

/** Upper bound on draining in-flight stdio handlers during shutdown. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

/** Readiness probes must not hang on a wedged backend. */
const READINESS_TIMEOUT_MS = 2_000;

import { filterTodos } from "./logic/Todos.ts";
import type { TodoBackend } from "./logic/backend.ts";
import { LocalFileBackend } from "./logic/backends/local-file-backend.ts";
import { WebDavBackend } from "./logic/backends/webdav-backend.ts";
import { loadConfig } from "./logic/config.ts";
import type { TodoTxtMcpConfig } from "./logic/config.ts";
import { createJsonContentTypeMiddleware } from "./logic/content-type.ts";
import { serializeTodoContent } from "./logic/content.ts";
import { probeReadiness } from "./logic/readiness.ts";
import { resolveReadOnlyMode } from "./logic/read-only.ts";
import { cleanupStaleTempFiles } from "./logic/todo-file-helpers.ts";
import {
  addTodosHandler,
  CompactAddTodosSchema,
  CompactDeleteTodosSchema,
  CompactListTodosSchema,
  CompactUpdateTodosSchema,
  deleteTodosHandler,
  listTodosHandler,
  updateTodosHandler,
} from "./logic/tools.ts";

export function createBackend(config: TodoTxtMcpConfig): TodoBackend {
  switch (config.backend) {
    case "webdav":
      return new WebDavBackend(
        config.webdav.url,
        config.webdav.username,
        config.webdav.password,
      );
    case "local":
      return new LocalFileBackend(config.local.filename);
    default: {
      const exhaustiveCheck: never = config;
      return exhaustiveCheck;
    }
  }
}

export interface CreateTodoMcpServerOptions {
  /** When true only `list_todos` is registered; mutating tools are absent. */
  readOnly?: boolean;
  /** Tracks in-flight handlers so a transport can drain before shutdown. */
  activity?: OperationTracker;
}


export function createTodoMcpServer(
  backend: TodoBackend,
  options: CreateTodoMcpServerOptions = {},
) {
  const readOnly = resolveReadOnlyMode(options, process.env);
  const tracked = <T>(work: () => T | Promise<T>): T | Promise<T> =>
    options.activity === undefined ? work() : options.activity.run(work);
  const server = new McpServer({
    name: "todo.txt-mcp",
    version: "3.2.0",
  });

  server.registerPrompt(
    "todo_format",
    {
      description:
        "todo.txt uses priorities, contexts, projects, dates and tags.",
    },
    () => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text:
            "todo.txt is a plain-text task format with one task per line.\n\n" +
            "- A completed task starts with `x `.\n" +
            "- A priority is `(A)` to `(Z)` at the start.\n" +
            "- Dates use `YYYY-MM-DD`.\n" +
            "- Projects are `+project` and contexts are `@context`.\n" +
            "- Tags include `due:YYYY-MM-DD`, `t:YYYY-MM-DD` and `rec:+2w`.\n",
        },
      }],
    }),
  );

  const textResource = (uri: URL, text: string) => ({
    contents: [{ uri: uri.href, mimeType: "text/plain" as const, text }],
  });

  server.registerResource(
    "todo-file",
    "todo://file",
    {
      title: "todo.txt",
      description: "The complete todo.txt file.",
      mimeType: "text/plain",
    },
    (uri) =>
      tracked(async () => {
        const todos = await backend.load();
        return textResource(uri, serializeTodoContent(todos));
      }),
  );

  server.registerResource(
    "todo-active",
    "todo://active",
    {
      title: "Active todos",
      description:
        "Visible open todos only; hidden and future-threshold todos omitted.",
      mimeType: "text/plain",
    },
    (uri) =>
      tracked(async () => {
        const todos = await backend.load();
        return textResource(
          uri,
          serializeTodoContent(filterTodos(todos, { status: "todo" })),
        );
      }),
  );

  server.registerResource(
    "todo-context",
    new ResourceTemplate("todo://context/{name}", { list: undefined }),
    {
      title: "Todos in a context",
      description: "Open todos in one @context, one per line.",
      mimeType: "text/plain",
    },
    async (uri, variables) => {
      const rawName = String(variables.name ?? "");
      let context = rawName;
      try {
        context = decodeURIComponent(rawName);
      } catch {
        // Keep the raw value when it is not valid percent-encoding.
      }
      return await tracked(async () => {
        const todos = await backend.load();
        const matching = filterTodos(todos, {
          status: "todo",
          context,
        });
        return textResource(uri, serializeTodoContent(matching));
      });
    },
  );

  server.registerTool(
    "list_todos",
    {
      description:
        "List todos as 'hash text' lines. Use offset to page.",
      inputSchema: CompactListTodosSchema.shape,
      annotations: { readOnlyHint: true },
    },
    (rawArgs: unknown) => tracked(() => listTodosHandler(backend, rawArgs)),
  );

  // Read-only mode keeps mutating tools out of tools/list and the callable
  // surface entirely. Resources and the format prompt remain available.
  if (readOnly) {
    return server;
  }

  server.registerTool(
    "add_todos",
    {
      description:
        "Add todo.txt lines (supports due:, t:, rec:); returns " +
        "'hash text' lines. Existing lines are skipped.",
      inputSchema: CompactAddTodosSchema.shape,
      annotations: { destructiveHint: false },
    },
    (rawArgs: unknown) => tracked(() => addTodosHandler(backend, rawArgs)),
  );

  server.registerTool(
    "update_todos",
    {
      description:
        "Update the first line matching each hash with '<hash> <new " +
        "todo.txt line>' lines. Copy the listed line and edit it; include " +
        "fields to keep. To complete, start with 'x ' and no date unless " +
        "the user gave one. A duplicate result returns CONFLICT. Repeat " +
        "with the same hash for the next duplicate.",
      inputSchema: CompactUpdateTodosSchema.shape,
      annotations: { destructiveHint: true },
    },
    (rawArgs: unknown) => tracked(() => updateTodosHandler(backend, rawArgs)),
  );

  server.registerTool(
    "delete_todos",
    {
      description:
        "Delete the first line matching each hash; returns 'hash text' " +
        "lines. Missing hashes return ERROR lines; refresh with list_todos. " +
        "Repeat with the same hash for the next duplicate.",
      inputSchema: CompactDeleteTodosSchema.shape,
      annotations: { destructiveHint: true },
    },
    (rawArgs: unknown) => tracked(() => deleteTodosHandler(backend, rawArgs)),
  );

  return server;
}

export interface RunStdioServerOptions
  extends Omit<CreateTodoMcpServerOptions, "activity"> {
  /** Protocol input. Defaults to `process.stdin`; injectable for tests. */
  stdin?: Readable;
  /** Protocol output. Defaults to `process.stdout`; injectable for tests. */
  stdout?: Writable;
}

/**
 * Serves MCP over stdin/stdout for clients that launch the process directly.
 *
 * stdout is reserved for protocol frames; every log record goes to stderr.
 * Authentication, Host/Origin validation, and metrics are HTTP concerns and
 * are intentionally not applied here.
 *
 * Resolves after a clean shutdown (stdin EOF, `SIGINT`, or `SIGTERM`).
 */
export async function runStdioServer(
  backend: TodoBackend,
  options: RunStdioServerOptions = {},
): Promise<void> {
  const activity = createOperationTracker();
  const logger = createLogger({
    level: resolveLogLevel(process.env),
    stderrOnly: true,
  });
  const server = createTodoMcpServer(backend, {
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
    activity,
  });
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const transport = new StdioServerTransport(stdin, stdout);

  let shutdownPromise: Promise<void> | undefined;
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });

  const removeListeners = () => {
    stdin.off("end", onEnd);
    stdin.off("close", onEnd);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };

  const onEnd = () => {
    void shutdown("stdin_end");
  };
  const onSigint = () => {
    void shutdown("SIGINT");
  };
  const onSigterm = () => {
    void shutdown("SIGTERM");
  };

  const shutdown = (reason: string): Promise<void> => {
    if (shutdownPromise !== undefined) {
      return shutdownPromise;
    }
    removeListeners();
    shutdownPromise = (async () => {
      logger.info("stdio_shutdown", { reason });

      // Pause the reader first so no new frames start, but leave the MCP
      // server open: closing it aborts in-flight handlers. Drain them so a
      // load -> mutate -> save cycle releases the advisory lock in `finally`.
      stdin.pause();
      const timedOut = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(true), SHUTDOWN_TIMEOUT_MS);
        timer.unref();
        void activity.idle().then(() => {
          clearTimeout(timer);
          resolve(false);
        });
      });

      if (timedOut) {
        logger.error("stdio_shutdown_timeout", {
          pendingOperations: activity.active(),
        });
        // A stuck backend must not keep the client's subprocess alive.
        process.exit(1);
      }

      try {
        await server.close();
      } catch (error) {
        logger.error("stdio_close_error", {
          message: error instanceof Error ? error.message : String(error),
        });
      }

      logger.info("stdio_stopped", { reason });
      resolveFinished();
    })();
    return shutdownPromise;
  };

  stdin.once("end", onEnd);
  stdin.once("close", onEnd);
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    await server.connect(transport);
  } catch (error) {
    await shutdown("connect_error");
    throw error;
  }

  logger.info("stdio_ready");
  await finished;
}

export { resolveReadOnlyMode };

export type CreateAppOptions = HttpSecurityOptions & {
  abuse?: AbuseControlOverrides;
  trustProxy?: string | number | boolean | string[];
  /** When true only `list_todos` is registered on the MCP endpoint. */
  readOnly?: boolean;
  /** Injectable structured logger, primarily for tests. */
  logger?: Logger;
  /** Overrides `MCP_LOG_LEVEL` for the default logger. */
  logLevel?: LogLevel;
  /** `/metrics` overrides for tests/embedders; resolved from env when absent. */
  metrics?: MetricsOverrides;
  /** Already-resolved metrics settings, used by `main()` for one source of truth. */
  resolvedMetrics?: ResolvedMetricsConfig;
  /** Readiness probe timeout in milliseconds. Default: 2000. */
  readinessTimeoutMs?: number;
};

/** Describes which credential `/metrics` uses, for the posture record only. */
function describeMetricsTokenSource(
  config: ResolvedMetricsConfig,
  authConfigured: boolean,
): "env" | "mcp" | "none" {
  if (!config.enabled) {
    return "none";
  }
  if (config.token !== undefined) {
    return "env";
  }
  return authConfigured ? "mcp" : "none";
}

interface RateLimitMiddlewareOptions {
  limiter: SlidingWindowLimiter;
  clientKey: (req: { ip?: string }) => string;
  logger: Logger;
  event: string;
  message: string;
}

/** Shared 429/header handling for the `/mcp` and `/metrics` limiters. */
function createRateLimitMiddleware(
  options: RateLimitMiddlewareOptions,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const key = options.clientKey(req);
    const limit = options.limiter.check(key);
    if (limit.limit > 0) {
      res.setHeader("RateLimit-Limit", String(limit.limit));
      res.setHeader("RateLimit-Remaining", String(limit.remaining));
      res.setHeader("RateLimit-Reset", String(limit.resetAfterSec));
    }
    if (!limit.allowed) {
      options.logger.warn(options.event, {
        requestId: getRequestId(req),
        ip: req.ip ?? "unknown",
        retryAfterSec: limit.retryAfterSec,
      });
      res.setHeader("Retry-After", String(limit.retryAfterSec));
      res.status(429).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: options.message },
        id: null,
      });
      return;
    }
    next();
  };
}

export function createApp(
  backend: TodoBackend,
  options: CreateAppOptions = {},
) {
  const { allowedHosts, allowedOrigins, authTokens, authTokenProvider } =
    resolveHttpSecurityOptions(options);
  const tokenSource = authTokenProvider ?? authTokens;
  const abuseOverrides = options.abuse ?? {};
  const abuseConfig = resolveAbuseConfig(process.env, abuseOverrides);
  const abuse = createAbuseControls(abuseConfig, abuseOverrides.now);
  const logger = options.logger ??
    createLogger({ level: options.logLevel ?? resolveLogLevel(process.env) });
  const metrics = createMetrics();
  const metricsConfig = options.resolvedMetrics ??
    resolveMetricsConfig(options.metrics, process.env);
  const readOnly = resolveReadOnlyMode(options, process.env);
  const mcpRateLimit = createRateLimitMiddleware({
    limiter: abuse.limiter,
    clientKey: abuse.clientKey,
    logger,
    event: "rate_limited",
    message: "Too many requests.",
  });
  const app = express();

  // Do not advertise the framework.
  app.disable("x-powered-by");

  // An empty allowlist means "no browser origins allowed". The transport
  // skips Origin validation when the list is empty, so pass a sentinel that
  // no real Origin can match to keep the behavior fail-closed.
  const transportOrigins = allowedOrigins.length > 0
    ? allowedOrigins
    : ["__no_origins_allowed__"];

  // Only opt into proxy headers when explicitly configured. Trusting
  // X-Forwarded-For without a real proxy lets clients spoof their limiter key.
  const trustProxy = parseTrustProxy(
    options.trustProxy ?? process.env.TRUST_PROXY,
  );
  if (trustProxy !== undefined) {
    app.set("trust proxy", trustProxy);
  }

  // Assign/echo a request ID and log one structured line per request. This
  // never includes Authorization, tokens, bodies, or todo content.
  app.use(createRequestLoggingMiddleware(logger));

  // Count every finished response, including health checks and rejections.
  app.use((_req: Request, res: Response, next) => {
    res.once("finish", () => metrics.recordRequest(res.statusCode));
    next();
  });

  // Security headers for the data-bearing endpoints.
  const securityHeaders = (
    _req: Request,
    res: Response,
    next: () => void,
  ) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    next();
  };
  app.use("/mcp", securityHeaders);
  app.use("/metrics", securityHeaders);
  app.use("/readyz", securityHeaders);

  // Port-agnostic Host validation protects against DNS rebinding.
  app.use(hostHeaderValidation(allowedHosts));

  // Never emit CORS headers when no origins are explicitly allowed.
  if (allowedOrigins.length > 0) {
    app.use(cors(buildCorsOptions(allowedOrigins)));
  }

  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  // Liveness stays cheap; readiness actually loads and serializes the todo
  // list so a bricked backend is visible. It is unauthenticated but still
  // Host-validated by the middleware above, and never returns the error.
  app.get("/readyz", async (req: Request, res: Response) => {
    const ready = await probeReadiness(
      backend,
      options.readinessTimeoutMs ?? READINESS_TIMEOUT_MS,
    );
    if (!ready) {
      logger.warn("readiness_failed", {
        requestId: getRequestId(req),
        ip: req.ip ?? "unknown",
      });
      res.status(503).json({ status: "unavailable" });
      return;
    }
    res.status(200).json({ status: "ready" });
  });

  // Abuse controls run before authentication so floods and banned keys are
  // rejected without doing token work. Health/readiness checks are never
  // affected. The global breaker is checked after authentication instead, so
  // a valid bearer is never shed because of other clients' failures.
  app.use("/mcp", (req: Request, res: Response, next) => {
    const key = abuse.clientKey(req);

    const ban = abuse.authFailures.getBan(key);
    if (ban.banned) {
      logger.warn("auth_banned", {
        requestId: getRequestId(req),
        ip: req.ip ?? "unknown",
        retryAfterSec: ban.retryAfterSec,
      });
      res.setHeader("Retry-After", String(ban.retryAfterSec));
      res.status(429).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Too many failed authentication attempts.",
        },
        id: null,
      });
      return;
    }

    mcpRateLimit(req, res, next);
  });

  if (authTokenProvider !== undefined || authTokens.length > 0) {
    app.use(
      "/mcp",
      createBearerAuthMiddleware(tokenSource, {
        onFailure: (req, res) => {
          metrics.recordAuthFailure();
          logger.warn("auth_failure", {
            requestId: getRequestId(req),
            ip: req.ip ?? "unknown",
            path: getRequestPath(req),
          });

          const key = abuse.clientKey(req);
          const breaker = abuse.breaker.recordFailure();
          if (breaker.openedNow) {
            logger.warn("auth_failure_circuit_breaker", {
              requestId: getRequestId(req),
              ip: req.ip ?? "unknown",
              retryAfterSec: breaker.retryAfterSec,
            });
          }

          const failure = abuse.authFailures.recordFailure(key);
          if (failure.banned) {
            logger.warn("auth_banned", {
              requestId: getRequestId(req),
              ip: req.ip ?? "unknown",
              retryAfterSec: failure.retryAfterSec,
            });
            res.setHeader("Retry-After", String(failure.retryAfterSec));
            res.status(429).json({
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message: "Too many failed authentication attempts.",
              },
              id: null,
            });
            return true;
          }

          // Invalid traffic is shed while the breaker is open, but a valid
          // token never reaches this hook and therefore always proceeds.
          if (breaker.open) {
            logger.warn("auth_failure_circuit_open", {
              requestId: getRequestId(req),
              ip: req.ip ?? "unknown",
              retryAfterSec: breaker.retryAfterSec,
            });
            res.setHeader("Retry-After", String(breaker.retryAfterSec));
            res.status(503).json({
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message:
                  "Service temporarily unavailable due to authentication failures.",
              },
              id: null,
            });
            return true;
          }
          return false;
        },
        onSuccess: (req) => {
          abuse.authFailures.recordSuccess(abuse.clientKey(req));
        },
      }),
    );
  }

  if (metricsConfig.enabled) {
    // A separate limiter and bucket so scrapes can neither exhaust the /mcp
    // budget nor trigger the /mcp auth ban or global breaker.
    const metricsLimiter = new SlidingWindowLimiter({
      limit: metricsConfig.rateLimitPerMin,
      windowMs: 60_000,
      maxEntries: abuseConfig.maxTrackedKeys,
      ...(abuseOverrides.now === undefined ? {} : { now: abuseOverrides.now }),
    });

    app.use(
      "/metrics",
      createRateLimitMiddleware({
        limiter: metricsLimiter,
        clientKey: abuse.clientKey,
        logger,
        event: "metrics_rate_limited",
        message: "Too many metrics requests.",
      }),
    );

    // When a separate metrics token is configured it is the only credential
    // accepted here. Otherwise reuse the /mcp token but bypass its lockout.
    const separateMetricsToken = metricsConfig.token;
    const metricsAuthConfigured = separateMetricsToken !== undefined ||
      authTokenProvider !== undefined || authTokens.length > 0;
    if (metricsAuthConfigured) {
      const metricsTokenSource = separateMetricsToken ?? tokenSource;
      app.use(
        "/metrics",
        createBearerAuthMiddleware(metricsTokenSource, {
          onFailure: (req) => {
            metrics.recordAuthFailure();
            logger.warn("auth_failure", {
              requestId: getRequestId(req),
              ip: req.ip ?? "unknown",
              path: getRequestPath(req),
            });
          },
        }),
      );
    }

    app.get("/metrics", (_req: Request, res: Response) => {
      res.setHeader(
        "Content-Type",
        "text/plain; version=0.0.4; charset=utf-8",
      );
      res.status(200).send(metrics.render());
    });
  }

  let inFlightMcpRequests = 0;

  // Cap concurrent POST work so the backend lock queue cannot grow without
  // bound. The counter is released on both finish and close.
  const concurrencyGuard = (
    _req: Request,
    res: Response,
    next: () => void,
  ) => {
    if (
      abuseConfig.maxConcurrency > 0 &&
      inFlightMcpRequests >= abuseConfig.maxConcurrency
    ) {
      logger.warn("concurrency_limited", {
        requestId: getRequestId(_req),
        ip: _req.ip ?? "unknown",
        maxConcurrency: abuseConfig.maxConcurrency,
      });
      res.setHeader("Retry-After", "1");
      res.status(503).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Server is busy. Try again later." },
        id: null,
      });
      return;
    }

    inFlightMcpRequests += 1;
    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      inFlightMcpRequests -= 1;
    };
    res.once("finish", release);
    res.once("close", release);
    next();
  };

  app.post(
    "/mcp",
    createJsonContentTypeMiddleware(),
    concurrencyGuard,
    async (req: Request, res: Response) => {
      // Create a new server and transport for each request to keep the
      // stateless endpoint free of request ID collisions.
      const server = createTodoMcpServer(backend, { readOnly });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        enableDnsRebindingProtection: true,
        // Host validation is handled by the port-agnostic middleware above.
        allowedOrigins: [...transportOrigins],
        maxRequestBodySize: 64 * 1024,
      });

      res.on("close", () => {
        void transport.close();
        void server.close();
      });

      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        logger.error("mcp_request_error", {
          requestId: getRequestId(req),
          ip: req.ip ?? "unknown",
          message: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          });
        }
      }
    },
  );

  app.get("/mcp", (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });

  app.delete("/mcp", (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });

  return app;
}

export async function main() {
  let transportMode: TransportMode;
  try {
    transportMode = resolveTransportMode();
  } catch (error) {
    console.error(
      `❌ ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
    return;
  }

  let config: TodoTxtMcpConfig;
  try {
    config = await loadConfig();
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error("❌ Configuration Error in todo.txt-mcp-config.json:");
      error.issues.forEach((issue) => {
        console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
      });
      process.exitCode = 1;
      return;
    }
    if (error instanceof SyntaxError) {
      console.error(
        "❌ Configuration Error: todo.txt-mcp-config.json is not valid JSON.",
      );
      console.error(`  ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const backend = createBackend(config);
  if (config.backend === "local") {
    // A killed writer can leave an abandoned temp file; clean old ones at the
    // composition root rather than as a backend-constructor side effect.
    cleanupStaleTempFiles(config.local.filename);
  }

  if (transportMode === "stdio") {
    // stdio mode skips HTTP-only concerns: bearer tokens, host/origin
    // allowlists, TLS, and metrics. stdout carries protocol frames only.
    await runStdioServer(backend);
    return;
  }

  let trustProxy: ReturnType<typeof parseTrustProxy>;
  try {
    trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
  } catch (error) {
    console.error(
      `❌ ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
    return;
  }

  const host = process.env.HOST ?? DEFAULT_HOST;
  const logger = createLogger({ level: resolveLogLevel(process.env) });
  const allowWeakTokens = isWeakTokenOverrideEnabled(
    process.env.MCP_ALLOW_WEAK_TOKEN,
  );
  const tokenFile = process.env.MCP_AUTH_TOKEN_FILE?.trim();

  // Resolve metrics before building the app: invalid boolean/rate values and
  // a weak separate metrics token fail startup with a clear message.
  let metricsConfig: ReturnType<typeof resolveMetricsConfig>;
  try {
    metricsConfig = resolveMetricsConfig({}, process.env);
    if (metricsConfig.token !== undefined) {
      assertStrongMetricsToken(
        metricsConfig.token,
        allowWeakTokens,
        (message) =>
          logger.warn("metrics_token_entropy_warning", { message }),
      );
    }
  } catch (error) {
    console.error(
      `❌ ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
    return;
  }

  // The weak-token override is an escape hatch for local experiments only.
  if (allowWeakTokens && !isLoopbackHost(host)) {
    console.error(
      `❌ MCP_ALLOW_WEAK_TOKEN=1 is only allowed when HOST is loopback ` +
        `(current HOST "${host}"). Unset MCP_ALLOW_WEAK_TOKEN or bind to ` +
        `127.0.0.1.`,
    );
    process.exitCode = 1;
    return;
  }
  if (allowWeakTokens) {
    logger.warn("weak_token_override_enabled", {
      host,
      message:
        "MCP_ALLOW_WEAK_TOKEN=1 is set; short or guessable tokens are " +
        "accepted. This is only safe for local experiments.",
    });
  }

  // Resolve and validate bearer tokens before building the app so a weak or
  // unreadable secret fails fast instead of silently disabling authentication.
  let authTokens: string[] = [];
  let authTokenSource: AuthTokenOrigin = "none";
  try {
    if (tokenFile !== undefined && tokenFile !== "") {
      warnOnInsecureTokenFile(tokenFile);
    }

    const resolvedTokens = resolveAuthTokens({}, process.env);
    authTokenSource = resolvedTokens.source;
    if (
      resolvedTokens.source === "env" || resolvedTokens.source === "file"
    ) {
      assertStrongAuthTokens(
        resolvedTokens.tokens,
        allowWeakTokens,
        resolvedTokens.source,
        (message) => logger.warn("auth_token_entropy_warning", { message }),
      );
    }
    assertAuthTokensConfigured(resolvedTokens.tokens);
    authTokens = resolvedTokens.tokens;
  } catch (error) {
    console.error(
      `❌ ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
    return;
  }

  // Keep the active list in a mutable store so SIGHUP can swap it atomically.
  const tokenStore = createAuthTokenStore(authTokens);
  const readOnlyMode = resolveReadOnlyMode({}, process.env);

  const proxyWarnings = warnOnProxyPosture(
    host,
    trustProxy,
    (message, fields) => {
      logger.warn("proxy_posture_warning", { ...fields, message });
    },
  ).map((warning) => warning.code);

  const metricsTokenSource = describeMetricsTokenSource(
    metricsConfig,
    authTokens.length > 0,
  );

  // Re-read and re-validate the token file on SIGHUP. A failed reload keeps the
  // previous tokens active; log only the count or the reason, never contents.
  if (tokenFile !== undefined && tokenFile !== "") {
    process.on("SIGHUP", () => {
      try {
        const nextTokens = readAuthTokenFile(tokenFile);
        assertStrongAuthTokens(
          nextTokens,
          allowWeakTokens,
          "file",
          (message) => logger.warn("auth_token_entropy_warning", { message }),
        );
        assertAuthTokensConfigured(nextTokens);
        tokenStore.set(nextTokens);
        logger.info("auth_tokens_reloaded", { count: nextTokens.length });
      } catch (error) {
        logger.warn("auth_tokens_reload_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  const app = createApp(backend, {
    logger,
    readOnly: readOnlyMode,
    ...(trustProxy === undefined ? {} : { trustProxy }),
    ...(authTokens.length > 0 ? { authTokens: tokenStore } : {}),
    resolvedMetrics: metricsConfig,
  });

  const port = Number(process.env.PORT ?? "3000");
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(
      `❌ Invalid PORT "${process.env.PORT}": expected an integer between 0 and 65535.`,
    );
    process.exitCode = 1;
    return;
  }

  const server = app.listen(port, host, () => {
    const address = server.address();
    const boundPort = typeof address === "object" && address !== null
      ? address.port
      : port;
    console.log(
      `todo.txt-mcp Server running on http://localhost:${boundPort}`,
    );
    console.log(`MCP Endpoint: http://localhost:${boundPort}/mcp`);

    logSecurityPosture(logger, {
      host,
      port: boundPort,
      ...(trustProxy === undefined ? {} : { trustProxy }),
      metrics: {
        enabled: metricsConfig.enabled,
        tokenSource: metricsTokenSource,
      },
      tokenSource: authTokenSource,
      tokenCount: authTokens.length,
      readOnly: readOnlyMode,
      backend: config.backend,
      allowWeakToken: allowWeakTokens,
      ...(process.env.MCP_READ_ONLY === undefined
        ? {}
        : { readOnlyValue: process.env.MCP_READ_ONLY }),
      proxyWarnings,
    });
  });

  // Bound slow-body and idle-connection attacks.
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  server.on("error", (error) => {
    console.error("❌ Failed to start todo.txt-mcp server:", error.message);
    process.exitCode = 1;
  });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      console.log(`Received ${signal}, shutting down.`);
      const forceExit = setTimeout(() => process.exit(1), 10_000);
      forceExit.unref();
      server.close(() => {
        clearTimeout(forceExit);
        process.exit(0);
      });
    });
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
