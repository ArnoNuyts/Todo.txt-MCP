import { assertStrongAuthTokens } from "./auth-tokens.ts";
import { DEFAULT_HOST, isLoopbackHost } from "./http-security.ts";

/**
 * `/metrics` is a read-only diagnostic endpoint. On a network bind it is also
 * an information leak and a token-guessing surface, so it is enabled by
 * default only for loopback binds. Callers can opt in explicitly.
 */
export const DEFAULT_METRICS_RATE_LIMIT_PER_MIN = 60;

export interface MetricsOverrides {
  enabled?: boolean;
  /** Separate metrics bearer token. Never the `/mcp` token. */
  token?: string;
  /** Scrapes per client key per minute. `0` disables the limiter. */
  rateLimitPerMin?: number;
  /** Bind host used to derive the network-safe default. */
  host?: string;
}

export interface ResolvedMetricsConfig {
  enabled: boolean;
  token?: string;
  rateLimitPerMin: number;
}

function parseBooleanSetting(
  value: string | undefined,
  name: string,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "") {
    return undefined;
  }
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  throw new Error(
    `Invalid ${name} "${value.trim()}": expected 1/true/yes or 0/false/no.`,
  );
}

/** Resolves `MCP_METRICS_ENABLED`, defaulting from the bind host. */
export function resolveMetricsEnabled(
  env: NodeJS.ProcessEnv = process.env,
  host: string = DEFAULT_HOST,
): boolean {
  return parseBooleanSetting(env.MCP_METRICS_ENABLED, "MCP_METRICS_ENABLED") ??
    isLoopbackHost(host);
}

/** Resolves `MCP_METRICS_RATE_LIMIT_PER_MIN`; invalid values fail fast. */
function resolveMetricsRateLimitPerMin(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.MCP_METRICS_RATE_LIMIT_PER_MIN;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_METRICS_RATE_LIMIT_PER_MIN;
  }
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(
      `Invalid MCP_METRICS_RATE_LIMIT_PER_MIN "${raw.trim()}": expected a ` +
        "non-negative integer.",
    );
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value)) {
    throw new Error(
      `Invalid MCP_METRICS_RATE_LIMIT_PER_MIN "${raw.trim()}": expected a ` +
        "non-negative integer.",
    );
  }
  return value;
}

/**
 * Parses the optional separate metrics token. Like the single `MCP_AUTH_TOKEN`
 * variable, a value containing whitespace or commas is rejected instead of
 * being split into several accidental tokens.
 */
export function parseMetricsToken(
  value: string | undefined,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const token = value.trim();
  if (token === "") {
    return undefined;
  }
  if (/[\s,]/.test(token)) {
    throw new Error(
      "Invalid MCP_METRICS_TOKEN: it must contain exactly one token with no " +
        "whitespace or commas.",
    );
  }
  return token;
}

/**
 * Applies the same strength rules as the `/mcp` environment tokens. Error
 * messages never include the token value.
 */
export function assertStrongMetricsToken(
  token: string,
  allowWeak: boolean,
  warn?: (message: string) => void,
): void {
  assertStrongAuthTokens([token], allowWeak, "MCP_METRICS_TOKEN", warn);
}

/** Resolves metrics settings from explicit overrides, then the environment. */
export function resolveMetricsConfig(
  overrides: MetricsOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedMetricsConfig {
  const envHost = env.HOST?.trim();
  const host = overrides.host?.trim() || envHost || DEFAULT_HOST;
  const token = overrides.token !== undefined
    ? parseMetricsToken(overrides.token)
    : parseMetricsToken(env.MCP_METRICS_TOKEN);

  return {
    enabled: overrides.enabled ?? resolveMetricsEnabled(env, host),
    rateLimitPerMin: overrides.rateLimitPerMin ??
      resolveMetricsRateLimitPerMin(env),
    ...(token === undefined ? {} : { token }),
  };
}
