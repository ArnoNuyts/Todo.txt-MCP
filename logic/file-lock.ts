import { randomUUID } from "node:crypto";
import { open, readFile, rm, stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

export interface FileLockOptions {
  /** Maximum time to wait for the lock before failing. Default: 5000 ms. */
  timeoutMs?: number;
  /** A lock older than this is considered abandoned. Default: 30000 ms. */
  staleMs?: number;
  /** Delay between acquisition attempts. Default: 25 ms. */
  retryMs?: number;
  /** Injectable clock, primarily for tests. */
  now?: () => number;
}

/** Raised when another process holds the lock for longer than `timeoutMs`. */
export class FileLockTimeoutError extends Error {
  readonly lockPath: string;
  readonly timeoutMs: number;

  constructor(lockPath: string, timeoutMs: number) {
    super(
      `Timed out after ${timeoutMs} ms waiting for the file lock at ` +
        `${lockPath}. Another writer may be busy; retry the operation.`,
    );
    this.name = "FileLockTimeoutError";
    this.lockPath = lockPath;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Runs `work` while holding an advisory lock file next to `target`.
 *
 * The lock is created with O_EXCL, so exactly one process on the same
 * filesystem can hold it. It is released in a `finally`. A lock whose recorded
 * PID is no longer alive, or that is older than `staleMs`, is treated as
 * abandoned so a crashed process cannot block writers forever.
 *
 * Advisory only: writers that do not use this helper (external editors,
 * WebDAV clients) are not blocked. The point is to serialize cooperating
 * processes that share a local file.
 */
export async function withFileLock<T>(
  target: string,
  work: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const staleMs = options.staleMs ?? 30_000;
  const retryMs = options.retryMs ?? 25;
  const now = options.now ?? Date.now;
  const lockPath = `${target}.lock`;
  const token = randomUUID();
  const deadline = now() + timeoutMs;

  await acquire(lockPath, token, {
    timeoutMs,
    deadline,
    staleMs,
    retryMs,
    now,
  });

  try {
    return await work();
  } finally {
    await release(lockPath, token);
  }
}

interface AcquireOptions {
  timeoutMs: number;
  deadline: number;
  staleMs: number;
  retryMs: number;
  now: () => number;
}

async function acquire(
  lockPath: string,
  token: string,
  options: AcquireOptions,
): Promise<void> {
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(
          `${token}\npid:${process.pid}\ncreated:${new Date(
            options.now(),
          ).toISOString()}\n`,
        );
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }

    // A lock left by a process that no longer exists (for example after
    // `kill -9`) can be reclaimed immediately instead of waiting for staleMs.
    const lockContent = await readFile(lockPath, "utf8").catch(() => undefined);
    const ownerPid = lockContent === undefined
      ? undefined
      : parseLockPid(lockContent);
    if (ownerPid !== undefined && !isProcessAlive(ownerPid)) {
      await rm(lockPath, { force: true }).catch(() => undefined);
      continue;
    }

    const info = await stat(lockPath).catch(() => undefined);
    if (info !== undefined && options.now() - info.mtimeMs > options.staleMs) {
      // Take over an abandoned lock. Two contenders may both try; O_EXCL above
      // still guarantees that only one of them creates the replacement.
      await rm(lockPath, { force: true }).catch(() => undefined);
      continue;
    }

    if (options.now() >= options.deadline) {
      throw new FileLockTimeoutError(lockPath, options.timeoutMs);
    }
    await sleep(options.retryMs);
  }
}

/** Extracts the `pid:<n>` line written into a lock file. */
function parseLockPid(content: string): number | undefined {
  const match = /^pid:(\d+)$/m.exec(content);
  if (match === null) {
    return undefined;
  }

  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Checks whether `pid` is still running. `EPERM` means the process exists but
 * belongs to another user, so it counts as alive.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function release(lockPath: string, token: string): Promise<void> {
  const content = await readFile(lockPath, "utf8").catch(() => undefined);
  // Only remove the lock if we still own it. If another process took over a
  // stale lock, its token differs and we leave it alone.
  if (content !== undefined && content.startsWith(`${token}\n`)) {
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}
