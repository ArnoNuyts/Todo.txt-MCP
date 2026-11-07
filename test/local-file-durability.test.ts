import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FileLockTimeoutError,
  withFileLock,
} from "../logic/file-lock.ts";
import {
  readTodosFromFile,
  writeTodosToFile,
} from "../logic/todo-file-helpers.ts";
import { Todo } from "../logic/todo.ts";

describe("local file durability", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "todo-txt-mcp-durability-"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  describe("write size limit", () => {
    it("rejects an oversized write without touching the file", async () => {
      const filename = join(tempDir, "todo.txt");
      await writeFile(filename, "old\n");

      await expect(
        writeTodosToFile([new Todo("task")], filename, undefined, {
          maxFileBytes: 4,
        }),
      ).rejects.toThrow(/too large/);

      expect(await readFile(filename, "utf8")).toBe("old\n");
      // No temporary file was created for the rejected write.
      expect(await readdir(tempDir)).toEqual(["todo.txt"]);
      // The unchanged file is still readable, so the writer is not locked out.
      expect(await readTodosFromFile(filename, { maxFileBytes: 4 }))
        .toHaveLength(1);
    });

    it("allows a write exactly at the limit", async () => {
      const filename = join(tempDir, "todo.txt");

      await writeTodosToFile([new Todo("task")], filename, undefined, {
        maxFileBytes: 5,
      });

      expect(await readFile(filename, "utf8")).toBe("task\n");
    });

    it("honors TODOTXT_MCP_MAX_FILE_BYTES when writing", async () => {
      vi.stubEnv("TODOTXT_MCP_MAX_FILE_BYTES", "4");
      const filename = join(tempDir, "todo.txt");

      await expect(writeTodosToFile([new Todo("task")], filename)).rejects
        .toThrow(/TODOTXT_MCP_MAX_FILE_BYTES/);

      expect(await readdir(tempDir)).toEqual([]);
    });
  });

  describe("invalid UTF-8", () => {
    it("refuses to read invalid bytes and leaves the file untouched", async () => {
      const filename = join(tempDir, "todo.txt");
      const bytes = Buffer.from([
        0x76,
        0x61,
        0x6c,
        0x69,
        0x64,
        0x0a,
        0xff,
        0xfe,
        0x0a,
      ]);
      await writeFile(filename, bytes);

      const error = await readTodosFromFile(filename).catch((raised: unknown) =>
        raised
      );

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(filename);
      expect((error as Error).message).toContain("not valid UTF-8");
      // The raw bytes must not be replaced or rewritten by the failed read.
      expect(await readFile(filename)).toEqual(bytes);
      expect(await readdir(tempDir)).toEqual(["todo.txt"]);
    });
  });

  describe("metadata preservation", () => {
    it("preserves the file mode across a write", async () => {
      const filename = join(tempDir, "todo.txt");
      await writeFile(filename, "old\n");
      await chmod(filename, 0o600);

      await writeTodosToFile([new Todo("new")], filename);

      expect((await stat(filename)).mode & 0o777).toBe(0o600);
      expect(await readFile(filename, "utf8")).toBe("new\n");
    });

    it("writes through a symlink without replacing the link", async () => {
      const realDir = join(tempDir, "real");
      await mkdir(realDir);
      const target = join(realDir, "todo.txt");
      const link = join(tempDir, "link.txt");
      await writeFile(target, "old\n");
      await symlink(target, link);

      await writeTodosToFile([new Todo("via-symlink")], link);

      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      expect(await readFile(target, "utf8")).toBe("via-symlink\n");
    });

    it("creates a nonexistent target", async () => {
      const filename = join(tempDir, "new.txt");

      await writeTodosToFile([new Todo("created")], filename);

      expect(await readFile(filename, "utf8")).toBe("created\n");
    });
  });

  describe("lock recovery", () => {
    async function exitedProcessPid(): Promise<number> {
      const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      const pid = child.pid;
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", () => resolve());
      });
      if (pid === undefined) {
        throw new Error("child process did not expose a pid");
      }
      return pid;
    }

    it("takes over a fresh lock whose process is dead", async () => {
      const filename = join(tempDir, "todo.txt");
      const lockPath = `${filename}.lock`;
      const deadPid = await exitedProcessPid();
      await writeFile(lockPath, `stale-token\npid:${deadPid}\n`);

      let ran = false;
      await withFileLock(filename, async () => {
        ran = true;
      }, { timeoutMs: 500, retryMs: 5 });

      expect(ran).toBe(true);
      await expect(stat(lockPath)).rejects.toThrow();
    });

    it("waits for a lock whose process is alive", async () => {
      const filename = join(tempDir, "todo.txt");
      const lockPath = `${filename}.lock`;
      await writeFile(lockPath, `live-token\npid:${process.pid}\n`);

      await expect(
        withFileLock(filename, async () => undefined, {
          timeoutMs: 40,
          retryMs: 5,
        }),
      ).rejects.toBeInstanceOf(FileLockTimeoutError);
    });

    it("reports the configured timeout, not the epoch deadline", async () => {
      const filename = join(tempDir, "todo.txt");

      await withFileLock(filename, async () => {
        const error = await withFileLock(filename, async () => undefined, {
          timeoutMs: 40,
          retryMs: 5,
        }).catch((raised: unknown) => raised);

        expect(error).toBeInstanceOf(FileLockTimeoutError);
        expect((error as FileLockTimeoutError).timeoutMs).toBe(40);
        expect((error as FileLockTimeoutError).message).toContain(
          "Timed out after 40 ms",
        );
      });
    });
  });
});
