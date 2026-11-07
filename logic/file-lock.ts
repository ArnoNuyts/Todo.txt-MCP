import { randomUUID } from "node:crypto";
import { readFileSync, readlinkSync } from "node:fs";
import type { Stats } from "node:fs";
import { open, realpath, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { isNotFoundError } from "./fs-errors.ts";

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

/** Reclaim attempts are serialized through this short-lived sidecar lock. */
const RECLAIM_LOCK_STALE_MS = 1_000;
/** How long `release` waits for the reclaim sidecar before giving up. */
const RELEASE_RECLAIM_WAIT_MS = 1_000;

interface LockIdentity {
  host: string;
  pidNamespace: string | undefined;
  bootId: string | undefined;
}

function readOptionalText(path: string): string | undefined {
  try {
    const value = readFileSync(path, "utf8").trim();
    return value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}

function readOptionalLink(path: string): string | undefined {
  try {
    const value = readlinkSync(path);
    return value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}

/** Reads the kernel's PID ceiling when available; Linux defaults to 4194304. */
const PLATFORM_MAX_PID = (() => {
  const value = Number(readOptionalText("/proc/sys/kernel/pid_max"));
  return Number.isSafeInteger(value) && value > 0 ? value : 4_194_304;
})();

let cachedIdentity: LockIdentity | undefined;

/**
 * Identifies the PID namespace a lock's PID is meaningful in. A PID alone is
 * only comparable on the same host, in the same PID namespace, during the same
 * boot. When the namespace marker is unavailable, PID-based reclaim is disabled
 * and the mtime fallback is used.
 */
function localLockIdentity(): LockIdentity {
  cachedIdentity ??= {
    host: hostname(),
    pidNamespace: readOptionalLink("/proc/self/ns/pid"),
    bootId: readOptionalText("/proc/sys/kernel/random/boot_id"),
  };
  return cachedIdentity;
}

/**
 * Runs `work` while holding an advisory lock file next to `target`.
 *
 * The lock is created with O_EXCL, so exactly one process on the same
 * filesystem can hold it. It is released in a `finally`.
 *
 * A lock is considered abandoned when its recorded PID is no longer alive on
 * the same host/PID namespace, or when it is older than `staleMs`. PID-based
 * reclaim is deliberately disabled for locks from another host or namespace
 * (containers, NFS/shared volumes) because those PIDs cannot be compared; such
 * locks only expire through the mtime fallback. A zombie process still looks
 * alive until it is reaped, so reclaim can be delayed by that window.
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
  const resolvedTarget = await resolveLockTarget(target);
  const lockPath = `${resolvedTarget}.lock`;
  const token = randomUUID();
  const deadline = now() + timeoutMs;
  const acquireOptions: AcquireOptions = {
    timeoutMs,
    deadline,
    staleMs,
    retryMs,
    now,
  };

  await acquire(lockPath, token, acquireOptions);

  try {
    return await work();
  } finally {
    await release(lockPath, token, acquireOptions);
  }
}

interface AcquireOptions {
  timeoutMs: number;
  deadline: number;
  staleMs: number;
  retryMs: number;
  now: () => number;
}

interface LockOwner {
  token: string;
  pid: number | undefined;
  host: string | undefined;
  pidNamespace: string | undefined;
  bootId: string | undefined;
}

interface ObservedLock {
  content: string;
  info: Stats;
  owner: LockOwner;
}

/** Resolves symlink aliases so they share one lock next to the real file. */
async function resolveLockTarget(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch (error) {
    if (isNotFoundError(error)) {
      return target;
    }
    throw error;
  }
}

function formatLockContent(token: string, now: number): string {
  const identity = localLockIdentity();
  const lines = [token, `pid:${process.pid}`, `host:${identity.host}`];
  if (identity.pidNamespace !== undefined) {
    lines.push(`pidns:${identity.pidNamespace}`);
  }
  if (identity.bootId !== undefined) {
    lines.push(`boot:${identity.bootId}`);
  }
  lines.push(`created:${new Date(now).toISOString()}`);
  return `${lines.join("\n")}\n`;
}

function parseLockContent(content: string): LockOwner {
  const lines = content.split("\n");
  const fields = new Map<string, string>();

  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    if (value !== "" && !fields.has(key)) {
      fields.set(key, value);
    }
  }

  return {
    token: lines[0] ?? "",
    pid: parseLockPid(fields.get("pid")),
    host: fields.get("host"),
    pidNamespace: fields.get("pidns"),
    bootId: fields.get("boot"),
  };
}

/** Rejects 0, negatives, non-numeric values and PIDs above the kernel ceiling. */
function parseLockPid(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) {
    return undefined;
  }

  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 0 && pid <= PLATFORM_MAX_PID
    ? pid
    : undefined;
}

/**
 * Only trust a PID when the lock was written by this host, PID namespace and
 * boot. Missing markers (old lock format, unsupported platform) fall back to
 * the mtime path.
 */
function canUsePidFastPath(owner: LockOwner): boolean {
  const local = localLockIdentity();
  if (owner.pid === undefined || owner.host !== local.host) {
    return false;
  }
  if (
    owner.pidNamespace === undefined ||
    local.pidNamespace === undefined ||
    owner.pidNamespace !== local.pidNamespace
  ) {
    return false;
  }
  if (
    owner.bootId !== undefined &&
    local.bootId !== undefined &&
    owner.bootId !== local.bootId
  ) {
    return false;
  }
  return true;
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

/**
 * Reads a consistent content/inode snapshot. The file handle pins one inode,
 * so `content` and `info` cannot describe two different lock files.
 */
async function observeLock(
  lockPath: string,
): Promise<ObservedLock | undefined> {
  let handle;
  try {
    handle = await open(lockPath, "r");
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }

  try {
    const info = await handle.stat();
    const content = await handle.readFile("utf8");
    return { content, info, owner: parseLockContent(content) };
  } finally {
    await handle.close();
  }
}

/**
 * Removes `lockPath` only if it is still the exact file that was observed.
 * Callers hold the reclaim sidecar while removing the main lock, so no other
 * cooperating process can replace it between the check and the unlink.
 */
async function removeObservedLock(
  lockPath: string,
  observed: ObservedLock,
): Promise<boolean> {
  const current = await observeLock(lockPath);
  if (
    current === undefined ||
    current.info.dev !== observed.info.dev ||
    current.info.ino !== observed.info.ino ||
    current.content !== observed.content
  ) {
    return false;
  }

  await rm(lockPath, { force: true });
  return true;
}

/**
 * Serializes reclaim attempts with `${lockPath}.reclaim`. If that sidecar is
 * itself abandoned, it is taken over after a short stale window.
 */
async function acquireReclaimLock(
  reclaimPath: string,
  token: string,
  deadline: number,
  retryMs: number,
  now: () => number,
): Promise<boolean> {
  for (;;) {
    try {
      const handle = await open(reclaimPath, "wx");
      try {
        await handle.writeFile(formatLockContent(token, now()));
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }

    const observed = await observeLock(reclaimPath);
    if (
      observed !== undefined &&
      now() - observed.info.mtimeMs > RECLAIM_LOCK_STALE_MS
    ) {
      await removeObservedLock(reclaimPath, observed);
      continue;
    }

    if (now() >= deadline) {
      return false;
    }
    await sleep(retryMs);
  }
}

async function releaseReclaimLock(
  reclaimPath: string,
  token: string,
): Promise<void> {
  const observed = await observeLock(reclaimPath);
  if (observed !== undefined && observed.owner.token === token) {
    await rm(reclaimPath, { force: true });
  }
}

/** Reclaims an abandoned main lock, serialized by the reclaim sidecar. */
async function reclaimLock(
  lockPath: string,
  observed: ObservedLock,
  options: AcquireOptions,
): Promise<boolean> {
  const reclaimPath = `${lockPath}.reclaim`;
  const token = randomUUID();
  const acquired = await acquireReclaimLock(
    reclaimPath,
    token,
    options.deadline,
    options.retryMs,
    options.now,
  );
  if (!acquired) {
    return false;
  }

  try {
    return await removeObservedLock(lockPath, observed);
  } finally {
    await releaseReclaimLock(reclaimPath, token);
  }
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
        await handle.writeFile(formatLockContent(token, options.now()));
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }

    const observed = await observeLock(lockPath);
    if (observed === undefined) {
      // The previous holder released it between our open and observe.
      continue;
    }

    // A lock left by a same-host process that no longer exists (for example
    // after `kill -9`, once the process has been reaped) can be reclaimed
    // immediately. PIDs from another host/namespace are never trusted.
    const ownerPid = observed.owner.pid;
    const ownerIsDead = ownerPid !== undefined &&
      canUsePidFastPath(observed.owner) &&
      !isProcessAlive(ownerPid);
    const isStale = options.now() - observed.info.mtimeMs > options.staleMs;
    if (ownerIsDead || isStale) {
      if (await reclaimLock(lockPath, observed, options)) {
        continue;
      }
    }

    if (options.now() >= options.deadline) {
      throw new FileLockTimeoutError(lockPath, options.timeoutMs);
    }
    await sleep(options.retryMs);
  }
}

/**
 * Releases our lock. Removal is serialized with reclaimers, and the token is
 * checked again under the reclaim sidecar, so a lock that was taken over is
 * never removed. If the sidecar cannot be acquired, the lock is left for the
 * stale fallback instead of risking an unsafe unlink.
 */
async function release(
  lockPath: string,
  token: string,
  options: AcquireOptions,
): Promise<void> {
  const observed = await observeLock(lockPath);
  if (observed === undefined || observed.owner.token !== token) {
    return;
  }

  const reclaimPath = `${lockPath}.reclaim`;
  const reclaimToken = randomUUID();
  const acquired = await acquireReclaimLock(
    reclaimPath,
    reclaimToken,
    options.now() + RELEASE_RECLAIM_WAIT_MS,
    options.retryMs,
    options.now,
  );
  if (!acquired) {
    // A reclaimer is active or wedged; leave the lock to the stale fallback
    // rather than risk unlinking a lock we no longer own.
    return;
  }

  try {
    const current = await observeLock(lockPath);
    if (current !== undefined && current.owner.token === token) {
      await rm(lockPath, { force: true });
    }
  } finally {
    await releaseReclaimLock(reclaimPath, reclaimToken);
  }
}
