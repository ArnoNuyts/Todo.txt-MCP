import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  FileLockTimeoutError,
  withFileLock,
} from "../logic/file-lock.ts";
import { LocalFileBackend } from "../logic/backends/local-file-backend.ts";
import { withBackendLock } from "../logic/backend-lock.ts";
import { Todo } from "../logic/todo.ts";

const temporaryDirectories: string[] = [];

async function makeTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "todo-lock-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("withFileLock", () => {
  it("serializes work across separate backend instances", async () => {
    const filename = join(await makeTempDirectory(), "todo.txt");
    const first = new LocalFileBackend(filename, { timeoutMs: 2_000 });
    const second = new LocalFileBackend(filename, { timeoutMs: 2_000 });

    let active = 0;
    let maxActive = 0;
    const work = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(30);
      active -= 1;
    };

    await Promise.all([
      first.withLock(work),
      second.withLock(work),
    ]);

    expect(maxActive).toBe(1);
  });

  it("times out while another process holds the lock", async () => {
    const filename = join(await makeTempDirectory(), "todo.txt");

    await withFileLock(filename, async () => {
      await expect(
        withFileLock(filename, async () => undefined, {
          timeoutMs: 40,
          retryMs: 5,
        }),
      ).rejects.toBeInstanceOf(FileLockTimeoutError);
    });
  });

  it("takes over an abandoned lock", async () => {
    const filename = join(await makeTempDirectory(), "todo.txt");
    const lockPath = `${filename}.lock`;
    await writeFile(lockPath, "abandoned-token\npid:1\n");
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);

    let ran = false;
    await withFileLock(filename, async () => {
      ran = true;
    }, { staleMs: 1_000, timeoutMs: 500 });

    expect(ran).toBe(true);
    await expect(stat(lockPath)).rejects.toThrow();
  });

  it("releases the lock when the work throws", async () => {
    const filename = join(await makeTempDirectory(), "todo.txt");
    const lockPath = `${filename}.lock`;

    await expect(
      withFileLock(filename, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await expect(stat(lockPath)).rejects.toThrow();
  });

  it("does not remove a lock that was taken over by someone else", async () => {
    const filename = join(await makeTempDirectory(), "todo.txt");
    const lockPath = `${filename}.lock`;

    await withFileLock(filename, async () => {
      // Simulate a stale takeover while we are still working.
      await writeFile(lockPath, "other-owner-token\npid:2\n");
    });

    expect(await readFile(lockPath, "utf8")).toContain("other-owner-token");
  });

  it("is used by withBackendLock when the backend provides it", async () => {
    let locked = 0;
    const backend = {
      async load() {
        return [] as Todo[];
      },
      async save() {
        // no-op
      },
      async withLock<T>(work: () => Promise<T>): Promise<T> {
        locked += 1;
        return await work();
      },
    };

    await withBackendLock(backend, async () => "ok");

    expect(locked).toBe(1);
  });
});
