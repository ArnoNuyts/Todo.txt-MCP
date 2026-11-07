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
  utimes,
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

    /** Captures a real lock file so host/namespace markers stay accurate. */
    async function lockTemplate(filename: string): Promise<string> {
      const lockPath = `${filename}.lock`;
      let template = "";
      await withFileLock(filename, async () => {
        template = await readFile(lockPath, "utf8");
      });
      return template;
    }

    function replaceField(
      content: string,
      key: string,
      value: string | undefined,
    ): string {
      const lines = content.split("\n").filter((line) =>
        !line.startsWith(`${key}:`)
      );
      if (value !== undefined) {
        const createdIndex = lines.findIndex((line) =>
          line.startsWith("created:")
        );
        lines.splice(
          createdIndex === -1 ? lines.length - 1 : createdIndex,
          0,
          `${key}:${value}`,
        );
      }
      return lines.join("\n");
    }

    function withToken(content: string, token: string): string {
      return content.replace(/^[^\n]*/, token);
    }

    async function expectLockTimeout(
      filename: string,
      timeoutMs: number,
    ): Promise<void> {
      await expect(
        withFileLock(filename, async () => undefined, {
          timeoutMs,
          retryMs: 5,
        }),
      ).rejects.toBeInstanceOf(FileLockTimeoutError);
    }

    it("takes over a fresh same-host lock whose process is dead", async () => {
      const filename = join(tempDir, "todo.txt");
      const lockPath = `${filename}.lock`;
      const template = await lockTemplate(filename);
      const deadPid = await exitedProcessPid();
      await writeFile(
        lockPath,
        withToken(replaceField(template, "pid", String(deadPid)), "stale-token"),
      );

      let ran = false;
      await withFileLock(filename, async () => {
        ran = true;
      }, { timeoutMs: 500, retryMs: 5 });

      expect(ran).toBe(true);
      await expect(stat(lockPath)).rejects.toThrow();
    });

    it("never fast-paths a lock from another host and falls back to mtime", async () => {
      const filename = join(tempDir, "todo.txt");
      const lockPath = `${filename}.lock`;
      const template = await lockTemplate(filename);
      const deadPid = await exitedProcessPid();
      const foreignHost = replaceField(
        replaceField(template, "pid", String(deadPid)),
        "host",
        "another-host.invalid",
      );
      await writeFile(lockPath, withToken(foreignHost, "foreign-token"));

      // A dead PID from another host must not trigger immediate reclaim.
      await expectLockTimeout(filename, 80);
      expect((await stat(lockPath)).isFile()).toBe(true);

      // The mtime fallback still reclaims it once it is old enough.
      const old = new Date(Date.now() - 60_000);
      await utimes(lockPath, old, old);

      let ran = false;
      await withFileLock(filename, async () => {
        ran = true;
      }, { timeoutMs: 500, retryMs: 5, staleMs: 1_000 });

      expect(ran).toBe(true);
    });

    const invalidPids: Array<[string, string | undefined]> = [
      ["missing", undefined],
      ["malformed", "not-a-number"],
      ["zero", "0"],
      ["negative", "-7"],
      ["out-of-range", "9007199254740991"],
    ];

    it.each(invalidPids)(
      "does not fast-path a %s PID",
      async (_label, pid) => {
        const filename = join(tempDir, "todo.txt");
        const lockPath = `${filename}.lock`;
        const template = await lockTemplate(filename);
        await writeFile(
          lockPath,
          withToken(replaceField(template, "pid", pid), "corrupt-token"),
        );

        await expectLockTimeout(filename, 60);
        expect((await stat(lockPath)).isFile()).toBe(true);
      },
    );

    it("waits for a live same-host lock", async () => {
      const filename = join(tempDir, "todo.txt");
      const lockPath = `${filename}.lock`;
      const template = await lockTemplate(filename);
      await writeFile(lockPath, withToken(template, "live-token"));

      await expectLockTimeout(filename, 40);
      expect((await stat(lockPath)).isFile()).toBe(true);
    });

    it("does not evict a live same-host owner whose lock mtime is stale", async () => {
      const filename = join(tempDir, "todo.txt");
      const lockPath = `${filename}.lock`;
      const template = await lockTemplate(filename);
      await writeFile(lockPath, withToken(template, "slow-live-token"));
      const old = new Date(Date.now() - 60_000);
      await utimes(lockPath, old, old);

      // A slow but healthy same-host writer can legitimately exceed staleMs;
      // only a known-dead owner or an unverifiable owner may be reclaimed.
      await expectLockTimeout(filename, 80);
      expect(await readFile(lockPath, "utf8")).toContain("slow-live-token");
    });

    it("uses one lock for symlink aliases of the same file", async () => {
      const realDir = join(tempDir, "real");
      await mkdir(realDir);
      const target = join(realDir, "todo.txt");
      const link = join(tempDir, "link.txt");
      await writeFile(target, "x\n");
      await symlink(target, link);

      await withFileLock(link, async () => {
        expect((await stat(`${target}.lock`)).isFile()).toBe(true);
        await expect(stat(`${link}.lock`)).rejects.toThrow();
        await expectLockTimeout(target, 40);
      });
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

    async function runContention(
      iterations: number,
      seed: (lockPath: string) => Promise<void>,
    ): Promise<number> {
      const filename = join(tempDir, "contention.txt");
      const lockPath = `${filename}.lock`;
      let maxActive = 0;

      for (let iteration = 0; iteration < iterations; iteration += 1) {
        await seed(lockPath);
        let active = 0;
        await Promise.all(
          Array.from({ length: 6 }, () =>
            withFileLock(filename, async () => {
              active += 1;
              maxActive = Math.max(maxActive, active);
              await new Promise((resolve) => setTimeout(resolve, 1));
              active -= 1;
            }, { timeoutMs: 5_000, retryMs: 1, staleMs: 5_000 })
          ),
        );
      }

      await expect(stat(lockPath)).rejects.toThrow();
      return maxActive;
    }

    it("serializes concurrent reclaimers of a dead-PID lock", async () => {
      const filename = join(tempDir, "seed.txt");
      const template = await lockTemplate(filename);
      const deadPid = await exitedProcessPid();
      const deadLock = withToken(
        replaceField(template, "pid", String(deadPid)),
        "dead-token",
      );

      const maxActive = await runContention(150, async (lockPath) => {
        await writeFile(lockPath, deadLock);
      });

      expect(maxActive).toBe(1);
    }, 30_000);

    it("serializes concurrent reclaimers of an mtime-stale lock", async () => {
      const maxActive = await runContention(150, async (lockPath) => {
        await writeFile(lockPath, "stale-token\n");
        const old = new Date(Date.now() - 60_000);
        await utimes(lockPath, old, old);
      });

      expect(maxActive).toBe(1);
    }, 30_000);

    it("takes over a stale reclaim sidecar", async () => {
      const filename = join(tempDir, "todo.txt");
      const lockPath = `${filename}.lock`;
      const reclaimPath = `${lockPath}.reclaim`;
      const old = new Date(Date.now() - 60_000);
      await writeFile(lockPath, "stale-token\n");
      await utimes(lockPath, old, old);
      await writeFile(reclaimPath, "wedged-token\npid:1\n");
      await utimes(reclaimPath, old, old);

      let ran = false;
      await withFileLock(filename, async () => {
        ran = true;
      }, { timeoutMs: 2_000, retryMs: 5, staleMs: 1_000 });

      expect(ran).toBe(true);
      await expect(stat(lockPath)).rejects.toThrow();
      await expect(stat(reclaimPath)).rejects.toThrow();
    });

    it("respects a fresh reclaim sidecar instead of deleting a live lock", async () => {
      const filename = join(tempDir, "todo.txt");
      const lockPath = `${filename}.lock`;
      const reclaimPath = `${lockPath}.reclaim`;
      const old = new Date(Date.now() - 60_000);
      await writeFile(lockPath, "stale-token\n");
      await utimes(lockPath, old, old);
      await writeFile(reclaimPath, "active-token\npid:1\n");

      await expect(
        withFileLock(filename, async () => undefined, {
          timeoutMs: 120,
          retryMs: 5,
          staleMs: 1_000,
        }),
      ).rejects.toBeInstanceOf(FileLockTimeoutError);

      // Both the abandoned main lock and the fresh sidecar are still there.
      expect((await stat(lockPath)).isFile()).toBe(true);
      expect((await stat(reclaimPath)).isFile()).toBe(true);
    });
  });
});
