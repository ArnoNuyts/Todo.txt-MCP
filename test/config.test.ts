import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadConfig } from "../logic/config.ts";

describe("loadConfig", () => {
  let tempDir = "";
  const configPath = () => join(tempDir, "todo.txt-mcp-config.json");

  const writeConfig = (config: unknown) =>
    writeFile(configPath(), JSON.stringify(config));

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "todo-txt-mcp-config-"));
    // Keep the "config file not found" notice out of the test output.
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("should default to the local backend with todo.txt", async () => {
    const config = await loadConfig({ cwd: tempDir, env: {} });

    expect(config).toEqual({
      backend: "local",
      local: { filename: "todo.txt" },
    });
  });

  it("should load the local backend from the config file", async () => {
    await writeConfig({
      backend: "local",
      local: { filename: "custom.txt" },
    });

    const config = await loadConfig({ cwd: tempDir, env: {} });

    expect(config).toEqual({
      backend: "local",
      local: { filename: "custom.txt" },
    });
  });

  it("should load the webdav backend from the config file", async () => {
    await writeConfig({
      backend: "webdav",
      webdav: {
        url: "https://example.com/dav",
        username: "user",
        password: "secret",
      },
    });

    const config = await loadConfig({ cwd: tempDir, env: {} });

    expect(config).toEqual({
      backend: "webdav",
      webdav: {
        url: "https://example.com/dav",
        username: "user",
        password: "secret",
      },
    });
  });

  it("should let environment variables override the config file", async () => {
    await writeConfig({
      backend: "local",
      local: { filename: "from-file.txt" },
    });

    const config = await loadConfig({
      cwd: tempDir,
      env: { TODOTXT_MCP_LOCAL_FILENAME: "from-env.txt" },
    });

    expect(config).toEqual({
      backend: "local",
      local: { filename: "from-env.txt" },
    });
  });

  it("should let environment variables switch the backend", async () => {
    await writeConfig({
      backend: "local",
      local: { filename: "todo.txt" },
    });

    const config = await loadConfig({
      cwd: tempDir,
      env: {
        TODOTXT_MCP_BACKEND: "webdav",
        TODOTXT_MCP_WEBDAV_URL: "https://env.example.com/dav",
      },
    });

    expect(config).toEqual({
      backend: "webdav",
      webdav: { url: "https://env.example.com/dav" },
    });
  });

  it("should reject an invalid JSON config file", async () => {
    await writeFile(configPath(), "{ not valid json");

    await expect(loadConfig({ cwd: tempDir, env: {} })).rejects.toThrow(
      SyntaxError,
    );
  });

  it("should reject a config file that fails schema validation", async () => {
    await writeConfig({ backend: "webdav" });

    await expect(loadConfig({ cwd: tempDir, env: {} })).rejects.toBeInstanceOf(
      z.ZodError,
    );
  });
});
