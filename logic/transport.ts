export type TransportMode = "http" | "stdio";

/**
 * Resolves the transport from CLI flags and environment.
 *
 * `--stdio` is the explicit opt-in and wins over the environment. HTTP stays
 * the default so existing deployments are unaffected.
 */
export function resolveTransportMode(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): TransportMode {
  if (argv.includes("--stdio")) {
    return "stdio";
  }

  const value = env.MCP_TRANSPORT?.trim().toLowerCase();
  if (value === undefined || value === "" || value === "http") {
    return "http";
  }
  if (value === "stdio") {
    return "stdio";
  }

  throw new Error(
    `Invalid MCP_TRANSPORT "${env.MCP_TRANSPORT}": expected "http" or "stdio".`,
  );
}
