import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertAuthTokensConfigured,
  assertStrongAuthTokens,
  createAuthTokenStore,
  isWeakTokenOverrideEnabled,
  MIN_TOKEN_LENGTH,
  parseAuthTokenList,
  readAuthTokenFile,
  resolveAuthTokens,
  warnOnInsecureTokenFile,
} from "../logic/auth-tokens.ts";

const directories: string[] = [];

// 32 hex characters: accepted, and hex is exempt from the "short" warning.
const STRONG_HEX_32 = "9f8e7d6c5b4a39281706f5e4d3c2b1a0";
// 64 hex characters: the recommended shape.
const STRONG_HEX_64 = STRONG_HEX_32.repeat(2);
// 44 non-hex characters: accepted with a length warning.
const BASE64URL_44 = "AbCdEfGhIjKlMnOpQrStUvWxYz-_9876543210aBcDeF";
// 41 non-hex characters: accepted with a length warning.
const BASE64URL_41 = "AbCdEfGhIjKlMnOpQrStUvWxYz-_9876543210aBc";

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "todo-txt-mcp-tokens-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("auth token parsing and resolution", () => {
  it("splits on commas and whitespace and removes duplicates", () => {
    expect(parseAuthTokenList(undefined)).toEqual([]);
    expect(parseAuthTokenList("")).toEqual([]);
    expect(parseAuthTokenList(" one, two\nthree\tfour ,, one "))
      .toEqual(["one", "two", "three", "four"]);
  });

  it("prefers explicit options over environment values", () => {
    const env = {
      MCP_AUTH_TOKEN: "env-single",
      MCP_AUTH_TOKENS: "env-list",
    };

    expect(resolveAuthTokens({ authToken: "option-single" }, env)).toEqual({
      tokens: ["option-single"],
      source: "options",
    });
    expect(resolveAuthTokens({ authTokens: ["a", "b", "a"] }, env)).toEqual({
      tokens: ["a", "b"],
      source: "options",
    });
    expect(resolveAuthTokens({ authTokens: [] }, env)).toEqual({
      tokens: [],
      source: "none",
    });
  });

  it("prefers the token file, then MCP_AUTH_TOKENS, then MCP_AUTH_TOKEN", async () => {
    const directory = await tempDirectory();
    const file = join(directory, "tokens");
    await writeFile(file, "file-token-one file-token-two\n", "utf8");

    expect(resolveAuthTokens({}, {
      MCP_AUTH_TOKEN_FILE: file,
      MCP_AUTH_TOKENS: "list-token",
      MCP_AUTH_TOKEN: "single-token",
    })).toEqual({
      tokens: ["file-token-one", "file-token-two"],
      source: "file",
      filePath: file,
    });

    expect(resolveAuthTokens({}, {
      MCP_AUTH_TOKENS: "list-one,list-two",
      MCP_AUTH_TOKEN: "single-token",
    })).toEqual({
      tokens: ["list-one", "list-two"],
      source: "env",
    });

    expect(resolveAuthTokens({}, { MCP_AUTH_TOKEN: "single-token" })).toEqual({
      tokens: ["single-token"],
      source: "env",
    });
  });

  it("reports a clear error for a missing or empty token file", async () => {
    const directory = await tempDirectory();
    const missing = join(directory, "missing");
    expect(() => readAuthTokenFile(missing)).toThrow(
      /Unable to read MCP_AUTH_TOKEN_FILE/,
    );

    const empty = join(directory, "empty");
    await writeFile(empty, "  \n", "utf8");
    expect(() => readAuthTokenFile(empty)).toThrow(
      /does not contain any tokens/,
    );
  });
});

describe("auth token validation", () => {
  it("rejects short environment tokens unless explicitly allowed", () => {
    const short = "too-short";
    let message = "";
    try {
      assertStrongAuthTokens([short], false);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(`shorter than ${MIN_TOKEN_LENGTH}`);
    expect(message).not.toContain(short);

    expect(() => assertStrongAuthTokens([short], true)).not.toThrow();
    expect(() => assertStrongAuthTokens([], false)).not.toThrow();
    expect(() => assertStrongAuthTokens([STRONG_HEX_32], false)).not.toThrow();
  });

  it("rejects repeated, low-variety, and common passphrase tokens", () => {
    for (
      const token of [
        "a".repeat(MIN_TOKEN_LENGTH),
        "ab".repeat(16),
        "passwordpasswordpasswordpassword",
        "prefix-changeme-9876543210abcdefghij",
      ]
    ) {
      let message = "";
      try {
        assertStrongAuthTokens([token], false);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(/weak|guessable/i);
      expect(message).not.toContain(token);
    }

    // The explicit weak override still permits them for local experiments.
    expect(() =>
      assertStrongAuthTokens(["a".repeat(MIN_TOKEN_LENGTH)], true)
    ).not.toThrow();
  });

  it("warns, but does not fail, for 32-42 character non-hex tokens", () => {
    const warnings: string[] = [];
    expect(() =>
      assertStrongAuthTokens([BASE64URL_41], false, "environment", (message) =>
        warnings.push(message))
    ).not.toThrow();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("openssl rand -hex 32");
    expect(warnings[0]).not.toContain(BASE64URL_41);

    // 43+ characters and hex tokens are fine without a warning.
    const strongWarnings: string[] = [];
    expect(() =>
      assertStrongAuthTokens(
        [BASE64URL_44, STRONG_HEX_32, STRONG_HEX_64],
        false,
        "environment",
        (message) => strongWarnings.push(message),
      )
    ).not.toThrow();
    expect(strongWarnings).toEqual([]);
  });

  it("rejects whitespace inside a single MCP_AUTH_TOKEN value", () => {
    let message = "";
    try {
      resolveAuthTokens({}, {
        MCP_AUTH_TOKEN: "correct horse battery staple",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/MCP_AUTH_TOKEN/);
    expect(message).toMatch(/single token|whitespace|comma/i);
    expect(message).not.toContain("horse");

    // List sources still split on whitespace and commas.
    expect(resolveAuthTokens({}, { MCP_AUTH_TOKENS: "one two,three" })).toEqual({
      tokens: ["one", "two", "three"],
      source: "env",
    });
  });

  it("supports a mutable token store for reloads", () => {
    const store = createAuthTokenStore([STRONG_HEX_32]);
    expect(store.get()).toEqual([STRONG_HEX_32]);
    store.set([STRONG_HEX_64]);
    expect(store.get()).toEqual([STRONG_HEX_64]);
  });

  it("recognizes the weak-token override values", () => {
    expect(isWeakTokenOverrideEnabled("1")).toBe(true);
    expect(isWeakTokenOverrideEnabled("true")).toBe(true);
    expect(isWeakTokenOverrideEnabled("YES")).toBe(true);
    expect(isWeakTokenOverrideEnabled("0")).toBe(false);
    expect(isWeakTokenOverrideEnabled(undefined)).toBe(false);
  });

  it("refuses to start when no auth token is configured", () => {
    expect(() => assertAuthTokensConfigured([])).toThrow(
      /Refusing to start: no MCP auth token is configured/,
    );
    expect(() => assertAuthTokensConfigured(["a".repeat(MIN_TOKEN_LENGTH)]))
      .not.toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "warns once when a token file is group/world-readable",
    async () => {
      const directory = await tempDirectory();
      const loose = join(directory, "loose-tokens");
      await writeFile(loose, "a".repeat(40), "utf8");
      await chmod(loose, 0o644);

      const warnings: string[] = [];
      expect(warnOnInsecureTokenFile(loose, (message) => warnings.push(message)))
        .toBe(true);
      expect(warnOnInsecureTokenFile(loose, (message) => warnings.push(message)))
        .toBe(false);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("accessible by group/other");
      expect(warnings[0]).not.toContain("a".repeat(40));

      const tight = join(directory, "tight-tokens");
      await writeFile(tight, "b".repeat(40), "utf8");
      await chmod(tight, 0o600);
      expect(warnOnInsecureTokenFile(tight, (message) => warnings.push(message)))
        .toBe(false);
      expect(warnings).toHaveLength(1);
    },
  );
});
