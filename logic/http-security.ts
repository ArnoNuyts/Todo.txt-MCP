import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import type { CorsOptions } from "cors";

export const DEFAULT_ALLOWED_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
export const DEFAULT_ALLOWED_ORIGINS = ["http://localhost:3000"];
export const DEFAULT_HOST = "127.0.0.1";

export const CORS_METHODS = ["GET", "POST", "DELETE", "OPTIONS"];
export const CORS_ALLOWED_HEADERS = [
  "content-type",
  "authorization",
  "mcp-session-id",
  "mcp-protocol-version",
];
export const CORS_EXPOSED_HEADERS = ["mcp-session-id"];

export interface HttpSecurityOptions {
  allowedHosts?: string | string[];
  allowedOrigins?: string | string[];
  authToken?: string;
}

export interface ResolvedHttpSecurityOptions {
  allowedHosts: string[];
  allowedOrigins: string[];
  authToken: string | undefined;
}

/**
 * Parses a comma-separated list (or an already-split array) into a clean list
 * of non-empty, trimmed entries. An explicitly empty value yields an empty
 * list; `undefined` falls back to the provided default.
 */
export function parseList(
  value: string | string[] | undefined,
  fallback: string[],
): string[] {
  if (value === undefined) {
    return [...fallback];
  }
  const entries = Array.isArray(value) ? value : value.split(",");
  return entries.map((entry) => entry.trim()).filter((entry) => entry !== "");
}

/**
 * Resolves the HTTP security settings from explicit options, falling back to
 * environment variables and finally to the secure defaults.
 */
export function resolveHttpSecurityOptions(
  options: HttpSecurityOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedHttpSecurityOptions {
  const allowedHosts = parseList(
    options.allowedHosts ?? env.MCP_ALLOWED_HOSTS,
    DEFAULT_ALLOWED_HOSTS,
  );
  const allowedOrigins = parseList(
    options.allowedOrigins ?? env.MCP_ALLOWED_ORIGINS,
    DEFAULT_ALLOWED_ORIGINS,
  );
  const rawToken = options.authToken ?? env.MCP_AUTH_TOKEN;
  const authToken = rawToken !== undefined && rawToken.trim() !== ""
    ? rawToken
    : undefined;

  return { allowedHosts, allowedOrigins, authToken };
}

/** Constant-time string comparison for secrets. */
export function tokensEqual(expected: string, provided: string): boolean {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(provided, "utf8");
  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, providedBuffer);
}

/** Extracts the bearer token from an Authorization header value. */
export function extractBearerToken(
  authorization: string | undefined,
): string | undefined {
  if (!authorization) {
    return undefined;
  }
  const match = /^Bearer[ \t]+(.+)$/i.exec(authorization.trim());
  return match?.[1];
}

/**
 * Express middleware requiring `Authorization: Bearer <token>`.
 * Responds with a 401 JSON-RPC error when the token is missing or wrong.
 */
export function createBearerAuthMiddleware(token: string): RequestHandler {
  return (req, res, next) => {
    const provided = extractBearerToken(req.headers.authorization);
    if (provided === undefined || !tokensEqual(token, provided)) {
      res.setHeader("WWW-Authenticate", "Bearer");
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized." },
        id: null,
      });
      return;
    }
    next();
  };
}

/**
 * Builds the CORS options for an explicit origin allowlist. Callers must skip
 * the middleware entirely when the allowlist is empty so that no CORS headers
 * are emitted at all.
 */
export function buildCorsOptions(allowedOrigins: string[]): CorsOptions {
  return {
    origin: [...allowedOrigins],
    methods: [...CORS_METHODS],
    allowedHeaders: [...CORS_ALLOWED_HEADERS],
    exposedHeaders: [...CORS_EXPOSED_HEADERS],
  };
}
