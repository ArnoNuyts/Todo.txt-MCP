/**
 * `/readyz` is unauthenticated, so it gets its own bounded rate limiter to
 * keep readiness probes from becoming a cheap way to drive backend loads.
 * `0` disables the limiter; `/healthz` is never limited.
 */
export const DEFAULT_READYZ_RATE_LIMIT_PER_MIN = 120;

function parseNonNegativeInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(
      `Invalid ${name} "${value}": expected a non-negative integer.`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(
      `Invalid ${name} "${value}": expected a non-negative integer.`,
    );
  }
  return parsed;
}

/**
 * Resolves `MCP_READYZ_RATE_LIMIT_PER_MIN` or an explicit override. Invalid
 * values fail startup instead of silently disabling the limiter.
 */
export function resolveReadyzRateLimitPerMin(
  override?: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (override !== undefined) {
    if (!Number.isSafeInteger(override) || override < 0) {
      throw new Error(
        `Invalid readiness rate limit "${override}": expected a ` +
          "non-negative integer.",
      );
    }
    return override;
  }

  const raw = env.MCP_READYZ_RATE_LIMIT_PER_MIN;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_READYZ_RATE_LIMIT_PER_MIN;
  }
  return parseNonNegativeInteger(
    raw.trim(),
    "MCP_READYZ_RATE_LIMIT_PER_MIN",
  );
}
