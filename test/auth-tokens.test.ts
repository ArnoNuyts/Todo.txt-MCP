import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertStrongAuthTokens,
  isWeakTokenOverrideEnabled,
  MIN_TOKEN_LENGTH,
  parseAuthTokenList,
  readAuthTokenFile,
  resolveAuthTokens,
  warnOnInsecureTokenFile,
} from "../logic/auth-tokens.ts";

const directories: string[] = [];

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
    expect(() => assertStrongAuthTokens(["a".repeat(MIN_TOKEN_LENGTH)], false))
      .not.toThrow();
  });

  it("recognizes the weak-token override values", () => {
    expect(isWeakTokenOverrideEnabled("1")).toBe(true);
    expect(isWeakTokenOverrideEnabled("true")).toBe(true);
    expect(isWeakTokenOverrideEnabled("YES")).toBe(true);
    expect(isWeakTokenOverrideEnabled("0")).toBe(false);
    expect(isWeakTokenOverrideEnabled(undefined)).toBe(false);
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
