import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import express from "express";
import type { Request, Response } from "express";
import cors from "cors";

import {
  buildCorsOptions,
  createBearerAuthMiddleware,
  DEFAULT_HOST,
  parseTrustProxy,
  type HttpSecurityOptions,
  resolveHttpSecurityOptions,
} from "./logic/http-security.ts";
import {
  type AbuseControlOverrides,
  createAbuseControls,
  resolveAbuseConfig,
} from "./logic/abuse-controls.ts";
import {
  assertAuthTokensConfigured,
  assertStrongAuthTokens,
  isWeakTokenOverrideEnabled,
  resolveAuthTokens,
  warnOnInsecureTokenFile,
} from "./logic/auth-tokens.ts";
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

import { filterTodos } from "./logic/Todos.ts";
import type { TodoBackend } from "./logic/backend.ts";
import { LocalFileBackend } from "./logic/backends/local-file-backend.ts";
import { WebDavBackend } from "./logic/backends/webdav-backend.ts";
import { loadConfig } from "./logic/config.ts";
import type { TodoTxtMcpConfig } from "./logic/config.ts";
import { createJsonContentTypeMiddleware } from "./logic/content-type.ts";
import { serializeTodoContent } from "./logic/content.ts";
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
}

/**
 * Resolves read-only mode from an explicit option, then `MCP_READ_ONLY`.
 * Accepts `1`, `true`, or `yes` (case-insensitive).
 */
export function resolveReadOnlyMode(
  options: { readOnly?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (options.readOnly !== undefined) {
    return options.readOnly;
  }
  const value = env.MCP_READ_ONLY?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export function createTodoMcpServer(
  backend: TodoBackend,
  options: CreateTodoMcpServerOptions = {},
) {
  const readOnly = resolveReadOnlyMode(options, process.env);
  const server = new McpServer({
    name: "todo.txt-mcp",
    version: "3.1.0",
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
    async (uri) => {
      const todos = await backend.load();
      return textResource(uri, serializeTodoContent(todos));
    },
  );

  server.registerResource(
    "todo-active",
    "todo://active",
    {
      title: "Active todos",
      description: "Open todos only, one per line.",
      mimeType: "text/plain",
    },
    async (uri) => {
      const todos = await backend.load();
      return textResource(
        uri,
        serializeTodoContent(todos.filter((todo) => !todo.isDone())),
      );
    },
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
      const todos = await backend.load();
      const matching = filterTodos(todos, {
        status: "todo",
        context,
      });
      return textResource(uri, serializeTodoContent(matching));
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
    (rawArgs: unknown) => listTodosHandler(backend, rawArgs),
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
        "'hash text' lines.",
      inputSchema: CompactAddTodosSchema.shape,
      annotations: { destructiveHint: false },
    },
    (rawArgs: unknown) => addTodosHandler(backend, rawArgs),
  );

  server.registerTool(
    "update_todos",
    {
      description:
        "Update by hash with '<hash> <new todo.txt line>' lines. Copy the " +
        "listed line and edit it; include fields to keep. To complete, start " +
        "with 'x ' and no date unless the user gave one. Missing hashes " +
        "return ERROR lines.",
      inputSchema: CompactUpdateTodosSchema.shape,
      annotations: { destructiveHint: true },
    },
    (rawArgs: unknown) => updateTodosHandler(backend, rawArgs),
  );

  server.registerTool(
    "delete_todos",
    {
      description:
        "Delete todos by hash; returns 'hash text' lines. Missing hashes " +
        "return ERROR lines; refresh with list_todos.",
      inputSchema: CompactDeleteTodosSchema.shape,
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    (rawArgs: unknown) => deleteTodosHandler(backend, rawArgs),
  );

  return server;
}

export type CreateAppOptions = HttpSecurityOptions & {
  abuse?: AbuseControlOverrides;
  trustProxy?: string | number | boolean | string[];
  /** When true only `list_todos` is registered on the MCP endpoint. */
  readOnly?: boolean;
  /** Injectable structured logger, primarily for tests. */
  logger?: Logger;
  /** Overrides `MCP_LOG_LEVEL` for the default logger. */
  logLevel?: LogLevel;
};

export function createApp(
  backend: TodoBackend,
  options: CreateAppOptions = {},
) {
  const { allowedHosts, allowedOrigins, authTokens } =
    resolveHttpSecurityOptions(options);
  const abuseOverrides = options.abuse ?? {};
  const abuseConfig = resolveAbuseConfig(process.env, abuseOverrides);
  const abuse = createAbuseControls(abuseConfig, abuseOverrides.now);
  const logger = options.logger ??
    createLogger({ level: options.logLevel ?? resolveLogLevel(process.env) });
  const metrics = createMetrics();
  const readOnly = resolveReadOnlyMode(options, process.env);
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

  // Port-agnostic Host validation protects against DNS rebinding.
  app.use(hostHeaderValidation(allowedHosts));

  // Never emit CORS headers when no origins are explicitly allowed.
  if (allowedOrigins.length > 0) {
    app.use(cors(buildCorsOptions(allowedOrigins)));
  }

  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  // Abuse controls run before authentication so floods and banned keys are
  // rejected without doing token work. Health checks are never affected.
  app.use("/mcp", (req: Request, res: Response, next) => {
    const key = abuse.clientKey(req);

    const breaker = abuse.breaker.state();
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
          message: "Service temporarily unavailable due to authentication failures.",
        },
        id: null,
      });
      return;
    }

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

    const limit = abuse.limiter.check(key);
    if (limit.limit > 0) {
      res.setHeader("RateLimit-Limit", String(limit.limit));
      res.setHeader("RateLimit-Remaining", String(limit.remaining));
      res.setHeader("RateLimit-Reset", String(limit.resetAfterSec));
    }
    if (!limit.allowed) {
      logger.warn("rate_limited", {
        requestId: getRequestId(req),
        ip: req.ip ?? "unknown",
        retryAfterSec: limit.retryAfterSec,
      });
      res.setHeader("Retry-After", String(limit.retryAfterSec));
      res.status(429).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Too many requests." },
        id: null,
      });
      return;
    }

    next();
  });

  if (authTokens.length > 0) {
    app.use(
      "/mcp",
      createBearerAuthMiddleware(authTokens, {
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
          return false;
        },
        onSuccess: (req) => {
          abuse.authFailures.recordSuccess(abuse.clientKey(req));
        },
      }),
    );
    // /metrics uses the same bearer check but deliberately bypasses the /mcp
    // abuse controls so a scraper cannot trip the login lockout.
    app.use(
      "/metrics",
      createBearerAuthMiddleware(authTokens, {
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

  // Resolve and validate bearer tokens before building the app so a weak or
  // unreadable secret fails fast instead of silently disabling authentication.
  let authTokens: string[] = [];
  try {
    const tokenFile = process.env.MCP_AUTH_TOKEN_FILE?.trim();
    if (tokenFile !== undefined && tokenFile !== "") {
      warnOnInsecureTokenFile(tokenFile);
    }

    const resolvedTokens = resolveAuthTokens({}, process.env);
    if (
      resolvedTokens.source === "env" || resolvedTokens.source === "file"
    ) {
      assertStrongAuthTokens(
        resolvedTokens.tokens,
        isWeakTokenOverrideEnabled(process.env.MCP_ALLOW_WEAK_TOKEN),
        resolvedTokens.source,
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

  const app = createApp(backend, {
    ...(trustProxy === undefined ? {} : { trustProxy }),
    ...(authTokens.length > 0 ? { authTokens } : {}),
  });

  const port = Number(process.env.PORT ?? "3000");
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(
      `❌ Invalid PORT "${process.env.PORT}": expected an integer between 0 and 65535.`,
    );
    process.exitCode = 1;
    return;
  }

  const host = process.env.HOST ?? DEFAULT_HOST;

  const server = app.listen(port, host, () => {
    const address = server.address();
    const boundPort = typeof address === "object" && address !== null
      ? address.port
      : port;
    console.log(
      `todo.txt-mcp Server running on http://localhost:${boundPort}`,
    );
    console.log(`MCP Endpoint: http://localhost:${boundPort}/mcp`);
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
