import type { AuthTokenOrigin } from "./auth-tokens.ts";
import { isLoopbackHost, type TrustProxyValue } from "./http-security.ts";
import type { Logger } from "./logging.ts";
import { isRecognizedReadOnlyValue } from "./read-only.ts";

/**
 * One startup record describing the security-relevant configuration. It is
 * intentionally secret-free: token counts and sources are reported, never
 * token values, request bodies, or todo content.
 */

type PostureTokenSource = AuthTokenOrigin;

/** Where `/metrics` gets its credential from, if it has one. */
type MetricsTokenSource = "env" | "mcp" | "none";

export interface SecurityPostureInput {
  host: string;
  port: number;
  trustProxy?: TrustProxyValue;
  metrics: {
    enabled: boolean;
    tokenSource: MetricsTokenSource;
  };
  tokenSource: PostureTokenSource;
  tokenCount: number;
  readOnly: boolean;
  backend: "local" | "webdav";
  allowWeakToken: boolean;
  /** Raw `MCP_READ_ONLY` value, used to detect unrecognized settings. */
  readOnlyValue?: string;
  /** Warning codes already emitted by `warnOnProxyPosture`. */
  proxyWarnings?: string[];
}

export interface SecurityPostureRecord {
  host: string;
  port: number;
  trustProxy: TrustProxyValue;
  metrics: {
    enabled: boolean;
    tokenSource: MetricsTokenSource;
  };
  tokenSource: PostureTokenSource;
  tokenCount: number;
  readOnly: boolean;
  backend: "local" | "webdav";
  warnings: string[];
}

/** Messages for posture warnings that do not have a dedicated log record. */
const POSTURE_WARNING_MESSAGES: Record<string, string> = {
  non_loopback_bind:
    "HOST is not loopback; the HTTP listener is reachable from the network. " +
    "Keep it behind a TLS proxy or a private tunnel.",
  metrics_enabled_non_loopback:
    "GET /metrics is enabled on a non-loopback bind. Restrict it at the proxy " +
    "and/or set MCP_METRICS_TOKEN.",
  read_only_value_unrecognized:
    "MCP_READ_ONLY has an unrecognized value; startup rejects it. Use " +
    "1/true/yes or 0/false/no.",
  env_token_non_loopback:
    "The MCP auth token comes from the environment on a non-loopback bind. " +
    "Prefer MCP_AUTH_TOKEN_FILE or a secret.",
};

function addWarning(warnings: string[], code: string): void {
  if (!warnings.includes(code)) {
    warnings.push(code);
  }
}

/**
 * Builds the startup posture record, including a stable list of warning codes.
 *
 * Proxy warnings are included here as codes, while the full messages are
 * emitted once by `warnOnProxyPosture` as `proxy_posture_warning` records. The
 * weak-token override keeps its existing `weak_token_override_enabled` record.
 */
export function buildSecurityPosture(
  input: SecurityPostureInput,
): SecurityPostureRecord {
  const loopback = isLoopbackHost(input.host);
  const warnings: string[] = [];

  if (!loopback) {
    addWarning(warnings, "non_loopback_bind");
  }
  if (!loopback && input.metrics.enabled) {
    addWarning(warnings, "metrics_enabled_non_loopback");
  }
  if (input.allowWeakToken) {
    addWarning(warnings, "weak_token_override");
  }
  for (const code of input.proxyWarnings ?? []) {
    addWarning(warnings, code);
  }
  if (
    input.readOnlyValue !== undefined &&
    !isRecognizedReadOnlyValue(input.readOnlyValue)
  ) {
    addWarning(warnings, "read_only_value_unrecognized");
  }
  if (!loopback && input.tokenSource === "env") {
    addWarning(warnings, "env_token_non_loopback");
  }

  return {
    host: input.host,
    port: input.port,
    trustProxy: input.trustProxy ?? false,
    metrics: {
      enabled: input.metrics.enabled,
      tokenSource: input.metrics.tokenSource,
    },
    tokenSource: input.tokenSource,
    tokenCount: input.tokenCount,
    readOnly: input.readOnly,
    backend: input.backend,
    warnings,
  };
}

/**
 * Emits exactly one `security_posture` info record and a structured warning
 * for each posture problem that does not already have its own log record.
 */
export function logSecurityPosture(
  logger: Logger,
  input: SecurityPostureInput,
): SecurityPostureRecord {
  const record = buildSecurityPosture(input);
  logger.info("security_posture", { ...record });

  for (const code of record.warnings) {
    const message = POSTURE_WARNING_MESSAGES[code];
    if (message !== undefined) {
      logger.warn("security_posture_warning", { code, message });
    }
  }

  return record;
}
