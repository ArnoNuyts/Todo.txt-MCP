import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { Request, RequestHandler, Response } from "express";
import type { CorsOptions } from "cors";
import {
  isDynamicAuthTokenSource,
  resolveAuthTokens,
  toAuthTokenProvider,
  type AuthTokenProvider,
  type AuthTokenSource,
  type AuthTokenStore,
} from "./auth-tokens.ts";

export const DEFAULT_ALLOWED_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
export const DEFAULT_ALLOWED_ORIGINS = ["http://localhost:3000"];
export const DEFAULT_HOST = "127.0.0.1";

const CORS_METHODS = ["GET", "POST", "DELETE", "OPTIONS"];
const CORS_ALLOWED_HEADERS = [
  "content-type",
  "authorization",
  "mcp-session-id",
  "mcp-protocol-version",
];
const CORS_EXPOSED_HEADERS = ["mcp-session-id"];

export interface HttpSecurityOptions {
  allowedHosts?: string | string[];
  allowedOrigins?: string | string[];
  /** Single bearer token. Kept for tests and backwards compatibility. */
  authToken?: string;
  /**
   * Active bearer tokens (during rotation) or a provider/store that is read on
   * every request so a token-file reload takes effect without a restart.
   */
  authTokens?: string[] | AuthTokenProvider | AuthTokenStore;
}

export interface ResolvedHttpSecurityOptions {
  allowedHosts: string[];
  allowedOrigins: string[];
  /** First configured token; kept for backwards compatibility. */
  authToken: string | undefined;
  /** All active tokens. Empty when authentication is disabled. */
  authTokens: string[];
  /** Present when the caller supplied a dynamic token source. */
  authTokenProvider?: AuthTokenProvider;
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
  const dynamicProvider = isDynamicAuthTokenSource(options.authTokens)
    ? toAuthTokenProvider(options.authTokens)
    : undefined;
  if (dynamicProvider !== undefined) {
    // Dynamic sources are read per request; do not snapshot them here, or
    // `authTokens` would go stale after the first reload.
    return {
      allowedHosts,
      allowedOrigins,
      authToken: undefined,
      authTokens: [],
      authTokenProvider: dynamicProvider,
    };
  }

  const resolvedTokens = resolveAuthTokens(
    {
      authToken: options.authToken,
      ...(Array.isArray(options.authTokens)
        ? { authTokens: options.authTokens }
        : {}),
    },
    env,
  );
  const authTokens = resolvedTokens.tokens;
  const authToken = authTokens[0];

  return { allowedHosts, allowedOrigins, authToken, authTokens };
}

/**
 * Constant-time string comparison for secrets.
 *
 * Both values are hashed first so the comparison always operates on fixed-size
 * digests. This avoids leaking the expected length through an early return and
 * makes the timing independent of the input length.
 */
export function tokensEqual(expected: string, provided: string): boolean {
  const expectedDigest = createHash("sha256")
    .update(expected, "utf8")
    .digest();
  const providedDigest = createHash("sha256")
    .update(provided, "utf8")
    .digest();
  return timingSafeEqual(expectedDigest, providedDigest);
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

export interface BearerAuthHooks {
  /**
   * Called after a missing or invalid token. Return `true` when the hook has
   * already written a response (for example a 429 lockout); otherwise the
   * middleware sends the standard 401.
   */
  onFailure?: (req: Request, res: Response) => boolean | void;
  /** Called after a valid token, before the request continues. */
  onSuccess?: (req: Request, res: Response) => void;
}

/**
 * Express middleware requiring `Authorization: Bearer <token>`.
 * Responds with a 401 JSON-RPC error when the token is missing or wrong.
 *
 * Accepts one token or a list of active tokens. Every configured token is
 * compared in constant time; the request is authorized when any matches.
 * Optional hooks let callers record failures/successes without coupling this
 * middleware to the abuse-control implementation.
 */
export function createBearerAuthMiddleware(
  token: AuthTokenSource,
  hooks: BearerAuthHooks = {},
): RequestHandler {
  const provider = toAuthTokenProvider(token);
  if (provider === undefined) {
    throw new Error("createBearerAuthMiddleware requires a token source.");
  }

  return (req, res, next) => {
    // Resolve per request: a token-file reload swaps the provider's contents
    // without rebuilding the Express app. A throwing provider fails closed.
    let expectedTokens: string[] = [];
    try {
      expectedTokens = provider().filter((entry) => entry !== "");
    } catch {
      expectedTokens = [];
    }
    const provided = extractBearerToken(req.headers.authorization);
    let authorized = false;
    if (provided !== undefined) {
      // Compare against every configured token instead of returning early so
      // the work does not reveal which token (if any) matched.
      for (const expected of expectedTokens) {
        if (tokensEqual(expected, provided)) {
          authorized = true;
        }
      }
    }

    if (!authorized) {
      res.locals.authResult = "fail";
      if (hooks.onFailure?.(req, res) === true) {
        return;
      }
      res.setHeader("WWW-Authenticate", "Bearer");
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized." },
        id: null,
      });
      return;
    }

    res.locals.authResult = "ok";
    hooks.onSuccess?.(req, res);
    next();
  };
}

export type TrustProxyValue = boolean | number | string | string[];

function isValidTrustProxyEntry(entry: string): boolean {
  if (entry === "loopback") {
    return true;
  }
  const parts = entry.split("/");
  if (parts.length > 2) {
    return false;
  }
  const [address, prefix] = parts;
  const version = isIP(address);
  if (version === 0) {
    return false;
  }
  if (prefix === undefined) {
    return true;
  }
  if (!/^\d+$/.test(prefix)) {
    return false;
  }
  const bits = Number(prefix);
  return bits >= 0 && bits <= (version === 4 ? 32 : 128);
}

/**
 * Parses `TRUST_PROXY`.
 *
 * Accepts `false`, `true`, a hop count (`1`..`n`), `loopback`, and a
 * comma-separated list of IP addresses or CIDR blocks. Returns `undefined`
 * when the variable is unset so callers can avoid touching Express's default.
 * Throws on malformed values; `main()` validates once at startup.
 */
export function parseTrustProxy(
  value: string | number | boolean | string[] | undefined,
): TrustProxyValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    const entries = value
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    for (const entry of entries) {
      if (!isValidTrustProxyEntry(entry)) {
        throw new Error(
          `Invalid TRUST_PROXY entry "${entry}": expected false, true, a hop count, "loopback", or IP/CIDR values.`,
        );
      }
    }
    return entries;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(
        `Invalid TRUST_PROXY "${value}": expected a non-negative integer.`,
      );
    }
    return value;
  }

  const trimmed = value.trim();
  if (trimmed === "" || /^false$/i.test(trimmed)) {
    return false;
  }
  if (/^true$/i.test(trimmed)) {
    return true;
  }
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }

  const entries = trimmed
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (entries.length === 0) {
    return false;
  }
  for (const entry of entries) {
    if (!isValidTrustProxyEntry(entry)) {
      throw new Error(
        `Invalid TRUST_PROXY entry "${entry}": expected false, true, a hop count, "loopback", or IP/CIDR values.`,
      );
    }
  }
  return entries.length === 1 ? entries[0] : entries;
}

/** True for loopback binds and the `localhost` hostname. */
export function isLoopbackHost(host: string): boolean {
  const trimmed = host.trim().toLowerCase();
  if (trimmed === "localhost") {
    return true;
  }
  const address = trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
  const version = isIP(address);
  if (version === 4) {
    return address.startsWith("127.");
  }
  if (version === 6) {
    return address === "::1" || address === "0:0:0:0:0:0:0:1";
  }
  return false;
}

function isWildcardTrustProxy(trustProxy: TrustProxyValue): boolean {
  if (trustProxy === true) {
    return true;
  }
  const entries = Array.isArray(trustProxy)
    ? trustProxy
    : typeof trustProxy === "string"
    ? trustProxy.split(",")
    : [];
  return entries.some((entry) => {
    const normalized = entry.trim().toLowerCase();
    return normalized === "true" || normalized === "0.0.0.0/0" ||
      normalized === "::/0";
  });
}

export interface ProxyPostureWarning {
  code: "proxy_trust_missing" | "proxy_trust_wildcard";
  message: string;
}

export type ProxyPostureWarn = (
  message: string,
  fields?: Record<string, unknown>,
) => void;

/**
 * Warns about proxy trust settings that are dangerous for a non-loopback bind.
 *
 * - No trust: every client looks like the proxy IP, so per-IP limits, lockouts,
 *   and logs are shared by all clients.
 * - Wildcard trust: `X-Forwarded-For` is attacker-controlled, so the same
 *   controls can be bypassed.
 *
 * Loopback binds are quiet because they are not reachable through a proxy.
 * Returns the warnings that were emitted; the sink is injectable for tests.
 */
export function warnOnProxyPosture(
  host: string,
  trustProxy: TrustProxyValue | undefined,
  warn: ProxyPostureWarn = (message, fields) => {
    if (fields === undefined) {
      console.warn(message);
    } else {
      console.warn(message, fields);
    }
  },
): ProxyPostureWarning[] {
  if (isLoopbackHost(host)) {
    return [];
  }

  const disabled = trustProxy === undefined || trustProxy === false ||
    trustProxy === 0 ||
    (Array.isArray(trustProxy) && trustProxy.length === 0);
  const warnings: ProxyPostureWarning[] = [];

  if (disabled) {
    warnings.push({
      code: "proxy_trust_missing",
      message:
        `[security] HOST "${host}" is not loopback but TRUST_PROXY is unset ` +
        `or false. Every client will appear as the proxy IP, so per-client ` +
        `limits, lockouts, and logs are ineffective. Set TRUST_PROXY=loopback ` +
        `for a same-host proxy, or the proxy's exact IP/CIDR.`,
    });
  } else if (isWildcardTrustProxy(trustProxy)) {
    warnings.push({
      code: "proxy_trust_wildcard",
      message:
        `[security] HOST "${host}" is not loopback and TRUST_PROXY trusts ` +
        `every hop (true or a /0 wildcard). Clients can spoof ` +
        `X-Forwarded-For and bypass per-IP limits, lockouts, and log ` +
        `attribution. Use TRUST_PROXY=loopback or the proxy's exact IP/CIDR.`,
    });
  }

  for (const warning of warnings) {
    warn(warning.message, { code: warning.code, host });
  }
  return warnings;
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
