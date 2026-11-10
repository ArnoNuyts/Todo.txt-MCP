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
/** Recommended minimum for an `openssl rand -hex 32` token. */
const RECOMMENDED_HEX_TOKEN_LENGTH = 64;
/** Recommended minimum for a base64url-encoded random token. */
const RECOMMENDED_BASE64URL_TOKEN_LENGTH = 43;

const MIN_DISTINCT_TOKEN_CHARACTERS = 10;
const WEAK_TOKEN_SUBSTRINGS = [
  "password",
  "secret",
  "changeme",
  "letmein",
  "qwerty",
  "admin",
  "123456",
];

export interface AuthTokenSourceOptions {
  authToken?: string;
  authTokens?: string[];
}

export type AuthTokenOrigin = "options" | "file" | "env" | "none";

export interface ResolvedAuthTokens {
  tokens: string[];
  source: AuthTokenOrigin;
  filePath?: string;
}

/** Returns the current token list. Called per request so reloads take effect. */
export type AuthTokenProvider = () => string[];

/** Small object form of a token provider, suitable for a mutable store. */
export interface AuthTokenStore {
  get(): string[];
}

export interface MutableAuthTokenStore extends AuthTokenStore {
  set(tokens: string[]): void;
}

export type AuthTokenSource =
  | string
  | string[]
  | AuthTokenProvider
  | AuthTokenStore;

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

function isDynamicTokenSource(
  source: AuthTokenSource | undefined,
): source is AuthTokenProvider | AuthTokenStore {
  return typeof source === "function" ||
    (typeof source === "object" && source !== null && !Array.isArray(source) &&
      typeof (source as AuthTokenStore).get === "function");
}

/**
 * Normalizes a token source into a provider that is safe to call per request.
 * Static strings and arrays are wrapped; dynamic sources are used as-is.
 */
export function toAuthTokenProvider(
  source: AuthTokenSource | undefined,
): AuthTokenProvider | undefined {
  if (source === undefined) {
    return undefined;
  }
  if (typeof source === "string") {
    return () => [source];
  }
  if (Array.isArray(source)) {
    return () => source;
  }
  if (typeof source === "function") {
    return source;
  }
  return () => source.get();
}

/** True when a source can change between requests (provider or store). */
export function isDynamicAuthTokenSource(
  source: AuthTokenSource | undefined,
): boolean {
  return isDynamicTokenSource(source);
}

/** Creates a token store that `SIGHUP` reloads can atomically swap. */
export function createAuthTokenStore(
  initialTokens: string[],
): MutableAuthTokenStore {
  let tokens = dedupe(initialTokens);
  return {
    get: () => tokens,
    set: (nextTokens: string[]) => {
      tokens = dedupe(nextTokens);
    },
  };
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

  // A single-token variable must not silently split a passphrase into several
  // weak tokens. Trim the edges, then reject internal whitespace or commas.
  const single = env.MCP_AUTH_TOKEN?.trim();
  if (single !== undefined && single !== "") {
    if (/[\s,]/.test(single)) {
      throw new Error(
        "Invalid MCP_AUTH_TOKEN: it must contain exactly one token with no " +
          "whitespace or commas. Use MCP_AUTH_TOKENS for a list or " +
          "MCP_AUTH_TOKEN_FILE for a token file.",
      );
    }
    return { tokens: [single], source: "env" };
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
 * True when a token is obviously guessable: a single repeated character, too
 * few distinct characters, or a common weak substring. Length is checked
 * separately so a long passphrase is still rejected.
 */
function isWeakAuthToken(token: string): boolean {
  if (new Set(token).size < MIN_DISTINCT_TOKEN_CHARACTERS) {
    return true;
  }
  const lower = token.toLowerCase();
  return WEAK_TOKEN_SUBSTRINGS.some((needle) => lower.includes(needle));
}

function isHexToken(token: string): boolean {
  return /^[0-9a-fA-F]+$/.test(token);
}

/**
 * Warns when a token is long enough to start but shorter than the recommended
 * CSPRNG shapes. A 32-42 character non-hex value may look strong but is easy to
 * produce by hand; 64 hex or 43+ base64url characters are the safe targets.
 * Returns the number of tokens that triggered a warning.
 */
function warnOnShortAuthTokens(
  tokens: string[],
  warn: (message: string) => void = console.warn,
  source: "environment" | "file" | "env" | string = "environment",
): number {
  const shortish = tokens.filter((token) =>
    token.length >= MIN_TOKEN_LENGTH &&
    token.length < RECOMMENDED_BASE64URL_TOKEN_LENGTH &&
    !isHexToken(token)
  );
  if (shortish.length === 0) {
    return 0;
  }
  warn(
    `[security] ${shortish.length} ${source} token(s) are ` +
      `${MIN_TOKEN_LENGTH}-${RECOMMENDED_BASE64URL_TOKEN_LENGTH - 1} ` +
      `characters and not hex. Prefer a generated token: ` +
      `"openssl rand -hex 32" (${RECOMMENDED_HEX_TOKEN_LENGTH} hex ` +
      `characters) or ${RECOMMENDED_BASE64URL_TOKEN_LENGTH}+ base64url ` +
      `characters.`,
  );
  return shortish.length;
}

/**
 * Rejects environment/file tokens that are shorter than
 * {@link MIN_TOKEN_LENGTH} or obviously guessable. Explicit options are
 * intentionally exempt so tests and embedders can use short fixtures. Error
 * messages never echo a token.
 */
export function assertStrongAuthTokens(
  tokens: string[],
  allowWeak: boolean,
  source: "environment" | "file" | "env" | string = "environment",
  warn?: (message: string) => void,
): void {
  if (allowWeak || tokens.length === 0) {
    return;
  }

  const shortCount = tokens.filter((token) =>
    token.length < MIN_TOKEN_LENGTH
  ).length;
  if (shortCount > 0) {
    throw new Error(
      `Refusing to start: ${shortCount} ${source} token(s) are shorter than ` +
        `${MIN_TOKEN_LENGTH} characters. Generate a token with ` +
        `"openssl rand -hex 32" or set MCP_ALLOW_WEAK_TOKEN=1 to override.`,
    );
  }

  const weakCount = tokens.filter(isWeakAuthToken).length;
  if (weakCount > 0) {
    throw new Error(
      `Refusing to start: ${weakCount} ${source} token(s) look weak or ` +
        `guessable (repeated characters, too few distinct characters, or a ` +
        `common word). Generate a token with "openssl rand -hex 32" or set ` +
        `MCP_ALLOW_WEAK_TOKEN=1 to override.`,
    );
  }

  warnOnShortAuthTokens(tokens, warn, source);
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
