import { readFileSync, statSync } from "node:fs";

/**
 * Helpers for resolving and validating bearer tokens.
 *
 * Tokens may come from explicit options (tests and programmatic callers), a
 * token file (`MCP_AUTH_TOKEN_FILE`), a comma/whitespace separated list
 * (`MCP_AUTH_TOKENS`), or a single value (`MCP_AUTH_TOKEN`). Multiple tokens
 * are active at the same time so a token can be rotated without downtime.
 */

export const MIN_TOKEN_LENGTH = 32;

export interface AuthTokenSourceOptions {
  authToken?: string;
  authTokens?: string[];
}

export type AuthTokenSource = "options" | "file" | "env" | "none";

export interface ResolvedAuthTokens {
  tokens: string[];
  source: AuthTokenSource;
  filePath?: string;
}

const warnedTokenFiles = new Set<string>();

/**
 * Splits a value on commas and any whitespace, trims the entries, drops empty
 * entries, and removes duplicates while preserving order.
 */
export function parseAuthTokenList(
  value: string | undefined | null,
): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const entry of value.split(/[\s,]+/)) {
    const token = entry.trim();
    if (token === "" || seen.has(token)) {
      continue;
    }
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

function dedupe(tokens: string[]): string[] {
  return [...new Set(tokens)];
}

/**
 * Reads one or more tokens from a file. Whitespace and commas separate tokens,
 * so a file may contain a single line, one token per line, or a mixed list.
 * Errors never include file contents.
 */
export function readAuthTokenFile(path: string): string[] {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to read MCP_AUTH_TOKEN_FILE "${path}": ${reason}`,
    );
  }

  const tokens = parseAuthTokenList(contents);
  if (tokens.length === 0) {
    throw new Error(
      `MCP_AUTH_TOKEN_FILE "${path}" does not contain any tokens.`,
    );
  }
  return tokens;
}

/**
 * Resolves the active token list.
 *
 * Precedence: explicit options, token file, `MCP_AUTH_TOKENS`, then
 * `MCP_AUTH_TOKEN`. The file wins over the environment list so an operator can
 * mount a secret and leave a stale list behind without accidentally keeping the
 * old token valid.
 */
export function resolveAuthTokens(
  options: AuthTokenSourceOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedAuthTokens {
  if (options.authTokens !== undefined) {
    const tokens = dedupe(
      options.authTokens.flatMap((entry) => parseAuthTokenList(entry)),
    );
    return tokens.length > 0
      ? { tokens, source: "options" }
      : { tokens: [], source: "none" };
  }

  if (options.authToken !== undefined) {
    const tokens = parseAuthTokenList(options.authToken);
    return tokens.length > 0
      ? { tokens, source: "options" }
      : { tokens: [], source: "none" };
  }

  const filePath = env.MCP_AUTH_TOKEN_FILE?.trim();
  if (filePath !== undefined && filePath !== "") {
    return {
      tokens: readAuthTokenFile(filePath),
      source: "file",
      filePath,
    };
  }

  const listTokens = parseAuthTokenList(env.MCP_AUTH_TOKENS);
  if (listTokens.length > 0) {
    return { tokens: listTokens, source: "env" };
  }

  const singleTokens = parseAuthTokenList(env.MCP_AUTH_TOKEN);
  if (singleTokens.length > 0) {
    return { tokens: singleTokens, source: "env" };
  }

  return { tokens: [], source: "none" };
}

/**
 * Refuses to start when no bearer token is configured. Authentication is
 * mandatory: an empty or unset token source must never silently expose the
 * MCP endpoint.
 */
export function assertAuthTokensConfigured(tokens: string[]): void {
  if (tokens.length === 0) {
    throw new Error(
      "Refusing to start: no MCP auth token is configured. Set " +
        "MCP_AUTH_TOKEN, MCP_AUTH_TOKENS, or MCP_AUTH_TOKEN_FILE to a strong " +
        "random value.",
    );
  }
}

/** True when `MCP_ALLOW_WEAK_TOKEN` explicitly opts out of length checks. */
export function isWeakTokenOverrideEnabled(
  value: string | undefined,
): boolean {
  if (value === undefined) {
    return false;
  }
  return /^(1|true|yes)$/i.test(value.trim());
}

/**
 * Rejects environment/file tokens shorter than {@link MIN_TOKEN_LENGTH}.
 * Explicit options are intentionally exempt so tests and embedders can use
 * short fixtures. Error messages never echo a token.
 */
export function assertStrongAuthTokens(
  tokens: string[],
  allowWeak: boolean,
  source: "environment" | "file" | "env" | string = "environment",
): void {
  if (allowWeak || tokens.length === 0) {
    return;
  }
  const weakCount = tokens.filter((token) =>
    token.length < MIN_TOKEN_LENGTH
  ).length;
  if (weakCount === 0) {
    return;
  }
  throw new Error(
    `Refusing to start: ${weakCount} ${source} token(s) are shorter than ` +
      `${MIN_TOKEN_LENGTH} characters. Generate a token with ` +
      `"openssl rand -hex 32" or set MCP_ALLOW_WEAK_TOKEN=1 to override.`,
  );
}

/**
 * Warns once per file when a POSIX token file is readable by group or other.
 * Returns true when a warning was emitted.
 */
export function warnOnInsecureTokenFile(
  path: string,
  warn: (message: string) => void = console.warn,
): boolean {
  if (process.platform === "win32") {
    return false;
  }
  if (warnedTokenFiles.has(path)) {
    return false;
  }

  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    // Reading the file will produce the actionable error elsewhere.
    return false;
  }

  if ((mode & 0o077) === 0) {
    return false;
  }

  warnedTokenFiles.add(path);
  const octal = (mode & 0o777).toString(8).padStart(3, "0");
  warn(
    `[security] MCP_AUTH_TOKEN_FILE "${path}" is accessible by group/other ` +
      `(mode ${octal}). Restrict it with "chmod 600" so only the server user ` +
      `can read it.`,
  );
  return true;
}
