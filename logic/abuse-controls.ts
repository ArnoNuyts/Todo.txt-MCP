import { isIP } from "node:net";

/**
 * Dependency-free abuse controls for the public `/mcp` endpoint:
 *
 * - a bounded per-key sliding-window rate limiter,
 * - a per-key authentication failure tracker with temporary bans,
 * - a global authentication-failure circuit breaker,
 * - client key normalization (IPv4, IPv6 /64, IPv4-mapped addresses).
 *
 * All state lives in the instances created by {@link createAbuseControls}, so
 * every Express app gets isolated counters. Tests can inject `now()`.
 */

export const DEFAULT_MAX_TRACKED_KEYS = 10_000;
export const UNKNOWN_CLIENT_KEY = "unknown";

/** Ban ladder for repeat offenders, in seconds. Capped at one hour. */
export const BAN_BACKOFF_LADDER_SEC = [60, 300, 900, 3_600] as const;
export const MAX_BAN_SEC = 3_600;

export interface AbuseConfig {
  /** Requests per client key per minute. `0` disables the limiter. */
  rateLimitPerMin: number;
  /** Failed authentications before a key is banned. */
  authFailLimit: number;
  /** Sliding window used to count failed authentications. */
  authFailWindowSec: number;
  /** Initial ban duration; repeated bans escalate up to one hour. */
  authBanSec: number;
  /** Maximum in-flight `/mcp` POST requests. `0` disables the guard. */
  maxConcurrency: number;
  /** Failed authentications per minute across all keys before shedding. */
  globalAuthFailLimit: number;
  /** Window for the global authentication-failure circuit breaker. */
  globalAuthFailWindowSec: number;
  /** How long the global circuit breaker stays open. */
  globalBreakerCooldownSec: number;
  /** Maximum number of keys retained by the bounded limiters. */
  maxTrackedKeys: number;
}

export interface AbuseControlOverrides extends Partial<AbuseConfig> {
  /** Injectable clock used by every control. Defaults to `Date.now`. */
  now?: () => number;
}

export const DEFAULT_ABUSE_CONFIG: AbuseConfig = {
  rateLimitPerMin: 60,
  authFailLimit: 10,
  authFailWindowSec: 900,
  authBanSec: 900,
  maxConcurrency: 20,
  globalAuthFailLimit: 100,
  globalAuthFailWindowSec: 60,
  globalBreakerCooldownSec: 60,
  maxTrackedKeys: DEFAULT_MAX_TRACKED_KEYS,
};

function readNonNegativeInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.floor(value);
}

function pick(
  override: number | undefined,
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  return override ?? readNonNegativeInt(env, name, fallback);
}

/**
 * Resolves abuse-control settings from explicit overrides, then environment
 * variables, then secure defaults. Invalid or negative values fall back to the
 * defaults rather than disabling a control accidentally.
 */
export function resolveAbuseConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<AbuseConfig> = {},
): AbuseConfig {
  return {
    rateLimitPerMin: pick(
      overrides.rateLimitPerMin,
      env,
      "MCP_RATE_LIMIT_PER_MIN",
      DEFAULT_ABUSE_CONFIG.rateLimitPerMin,
    ),
    authFailLimit: pick(
      overrides.authFailLimit,
      env,
      "MCP_AUTH_FAIL_LIMIT",
      DEFAULT_ABUSE_CONFIG.authFailLimit,
    ),
    authFailWindowSec: pick(
      overrides.authFailWindowSec,
      env,
      "MCP_AUTH_FAIL_WINDOW_SEC",
      DEFAULT_ABUSE_CONFIG.authFailWindowSec,
    ),
    authBanSec: pick(
      overrides.authBanSec,
      env,
      "MCP_AUTH_BAN_SEC",
      DEFAULT_ABUSE_CONFIG.authBanSec,
    ),
    maxConcurrency: pick(
      overrides.maxConcurrency,
      env,
      "MCP_MAX_CONCURRENCY",
      DEFAULT_ABUSE_CONFIG.maxConcurrency,
    ),
    globalAuthFailLimit: pick(
      overrides.globalAuthFailLimit,
      env,
      "MCP_GLOBAL_AUTH_FAIL_LIMIT",
      DEFAULT_ABUSE_CONFIG.globalAuthFailLimit,
    ),
    globalAuthFailWindowSec: pick(
      overrides.globalAuthFailWindowSec,
      env,
      "MCP_GLOBAL_AUTH_FAIL_WINDOW_SEC",
      DEFAULT_ABUSE_CONFIG.globalAuthFailWindowSec,
    ),
    globalBreakerCooldownSec: pick(
      overrides.globalBreakerCooldownSec,
      env,
      "MCP_GLOBAL_AUTH_FAIL_BAN_SEC",
      DEFAULT_ABUSE_CONFIG.globalBreakerCooldownSec,
    ),
    maxTrackedKeys: pick(
      overrides.maxTrackedKeys,
      env,
      "MCP_MAX_TRACKED_KEYS",
      DEFAULT_ABUSE_CONFIG.maxTrackedKeys,
    ),
  };
}

/**
 * Computes the ban duration for the nth consecutive lockout.
 *
 * The first lockout uses the configured base duration. Repeat lockouts are at
 * least the 1m → 5m → 15m → 1h ladder and grow exponentially from the base,
 * capped at one hour.
 */
export function banDurationSec(banCount: number, baseSec: number): number {
  const base = Math.max(1, Math.floor(baseSec));
  if (banCount <= 1) {
    return Math.min(MAX_BAN_SEC, base);
  }
  const exponential = base * 2 ** (banCount - 1);
  const ladderIndex = Math.min(banCount - 1, BAN_BACKOFF_LADDER_SEC.length - 1);
  return Math.min(
    MAX_BAN_SEC,
    Math.max(exponential, BAN_BACKOFF_LADDER_SEC[ladderIndex]),
  );
}

function normalizeIpv6Groups(value: string): string[] | undefined {
  const parts = value.split("::");
  if (parts.length > 2) {
    return undefined;
  }
  const head = parseIpv6Part(parts[0]);
  const tail = parts.length === 2 ? parseIpv6Part(parts[1]) : [];
  if (head === undefined || tail === undefined) {
    return undefined;
  }
  if (parts.length === 1) {
    return head.length === 8 ? head : undefined;
  }
  const missing = 8 - head.length - tail.length;
  if (missing < 0) {
    return undefined;
  }
  return [...head, ...Array<string>(missing).fill("0"), ...tail];
}

function parseIpv6Part(part: string): string[] | undefined {
  if (part === "") {
    return [];
  }
  const groups: string[] = [];
  const pieces = part.split(":");
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index];
    if (index === pieces.length - 1 && piece.includes(".")) {
      // Embedded IPv4 tail, e.g. `::ffff:192.0.2.1` or `2001:db8::192.0.2.1`.
      const octets = piece.split(".");
      if (octets.length !== 4) {
        return undefined;
      }
      const numbers = octets.map((octet) => Number(octet));
      if (
        numbers.some((number) =>
          !Number.isInteger(number) || number < 0 || number > 255
        )
      ) {
        return undefined;
      }
      groups.push((((numbers[0] << 8) | numbers[1]) >>> 0).toString(16));
      groups.push((((numbers[2] << 8) | numbers[3]) >>> 0).toString(16));
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(piece)) {
      return undefined;
    }
    groups.push(piece);
  }
  return groups;
}

function compressGroup(group: string): string {
  const trimmed = group.replace(/^0+/, "");
  return trimmed === "" ? "0" : trimmed;
}

/**
 * Normalizes a client address into a bounded limiter key.
 *
 * IPv6 clients are keyed by their /64 prefix so a single client cannot rotate
 * through addresses inside its own allocation. IPv4-mapped IPv6 addresses are
 * reduced to plain IPv4. Missing or unparseable values fall back to
 * {@link UNKNOWN_CLIENT_KEY} rather than throwing.
 */
export function normalizeClientIp(
  ip: string | undefined | null,
): string {
  if (ip === undefined || ip === null) {
    return UNKNOWN_CLIENT_KEY;
  }
  let value = ip.trim().toLowerCase();
  if (value === "") {
    return UNKNOWN_CLIENT_KEY;
  }

  // `[2001:db8::1]` or `[2001:db8::1]:443`.
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) {
    value = bracketed[1];
  }

  // Express may report IPv4-mapped addresses as `::ffff:127.0.0.1`.
  if (value.startsWith("::ffff:")) {
    value = value.slice("::ffff:".length);
  }

  if (isIP(value) === 4) {
    return value;
  }
  if (isIP(value) !== 6) {
    // Not an IP literal. Keep a stable, bounded key instead of trusting
    // arbitrary header content.
    return value === "" ? UNKNOWN_CLIENT_KEY : value;
  }

  const zoneIndex = value.indexOf("%");
  if (zoneIndex !== -1) {
    value = value.slice(0, zoneIndex);
  }

  const groups = normalizeIpv6Groups(value);
  if (groups === undefined) {
    return value;
  }
  return `${groups.slice(0, 4).map(compressGroup).join(":")}::/64`;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the current window frees capacity. */
  resetAfterSec: number;
  /** Seconds a rejected client should wait before retrying (at least 1). */
  retryAfterSec: number;
}

export interface SlidingWindowLimiterOptions {
  limit: number;
  windowMs: number;
  maxEntries?: number;
  now?: () => number;
}

/**
 * Bounded per-key sliding-window limiter.
 *
 * Each key stores at most `limit` timestamps; the key map is capped with LRU
 * eviction so rotating source addresses cannot exhaust memory. Entries are
 * also pruned lazily as their timestamps fall out of the window.
 */
export class SlidingWindowLimiter {
  readonly limit: number;
  readonly windowMs: number;
  readonly maxEntries: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, number[]>();

  constructor(options: SlidingWindowLimiterOptions) {
    this.limit = Math.max(0, Math.floor(options.limit));
    this.windowMs = Math.max(1, Math.floor(options.windowMs));
    this.maxEntries = Math.max(
      1,
      Math.floor(options.maxEntries ?? DEFAULT_MAX_TRACKED_KEYS),
    );
    this.now = options.now ?? (() => Date.now());
  }

  get size(): number {
    return this.entries.size;
  }

  /** Drops entries whose most recent hit is outside the window. */
  pruneExpired(): void {
    const cutoff = this.now() - this.windowMs;
    for (const [key, timestamps] of this.entries) {
      const last = timestamps[timestamps.length - 1];
      if (last === undefined || last <= cutoff) {
        this.entries.delete(key);
      }
    }
  }

  check(key: string): RateLimitDecision {
    if (this.limit <= 0) {
      return {
        allowed: true,
        limit: 0,
        remaining: 0,
        resetAfterSec: 0,
        retryAfterSec: 0,
      };
    }

    const now = this.now();
    const cutoff = now - this.windowMs;

    const previous = this.entries.get(key) ?? [];
    // Re-insert to refresh LRU ordering.
    this.entries.delete(key);

    let firstActive = 0;
    while (
      firstActive < previous.length && previous[firstActive] <= cutoff
    ) {
      firstActive += 1;
    }
    let timestamps = firstActive === 0
      ? previous
      : previous.slice(firstActive);

    if (timestamps.length >= this.limit) {
      const resetMs = Math.max(
        0,
        (timestamps[0] ?? now) + this.windowMs - now,
      );
      const resetAfterSec = Math.ceil(resetMs / 1000);
      this.entries.set(key, timestamps);
      this.evictOverflow();
      return {
        allowed: false,
        limit: this.limit,
        remaining: 0,
        resetAfterSec,
        retryAfterSec: Math.max(1, resetAfterSec),
      };
    }

    timestamps = [...timestamps, now];
    this.entries.set(key, timestamps);
    this.evictOverflow();

    const resetMs = Math.max(
      0,
      (timestamps[0] ?? now) + this.windowMs - now,
    );
    return {
      allowed: true,
      limit: this.limit,
      remaining: Math.max(0, this.limit - timestamps.length),
      resetAfterSec: Math.ceil(resetMs / 1000),
      retryAfterSec: 0,
    };
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      this.entries.delete(oldest);
    }
  }
}

interface AuthFailureState {
  failures: number[];
  bannedUntil: number;
  banCount: number;
}

export interface BanDecision {
  banned: boolean;
  retryAfterSec: number;
  banCount: number;
}

export interface AuthFailureTrackerOptions {
  limit: number;
  windowMs: number;
  banSec: number;
  maxEntries?: number;
  now?: () => number;
}

/**
 * Per-key failed-authentication tracker with automatic, temporary bans.
 *
 * Reaching `limit` failures inside `windowMs` starts a ban. A successful
 * authentication clears the key entirely. Expired bans clear themselves and
 * reset the failure window, but keep the repeat-offender count so consecutive
 * lockouts escalate up to one hour.
 */
export class AuthFailureTracker {
  readonly limit: number;
  readonly windowMs: number;
  readonly banSec: number;
  readonly maxEntries: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, AuthFailureState>();

  constructor(options: AuthFailureTrackerOptions) {
    this.limit = Math.max(0, Math.floor(options.limit));
    this.windowMs = Math.max(1, Math.floor(options.windowMs));
    this.banSec = Math.max(1, Math.floor(options.banSec));
    this.maxEntries = Math.max(
      1,
      Math.floor(options.maxEntries ?? DEFAULT_MAX_TRACKED_KEYS),
    );
    this.now = options.now ?? (() => Date.now());
  }

  get size(): number {
    return this.entries.size;
  }

  getBan(key: string): BanDecision {
    const state = this.entries.get(key);
    if (state === undefined) {
      return { banned: false, retryAfterSec: 0, banCount: 0 };
    }
    const now = this.now();
    this.entries.delete(key);
    this.entries.set(key, state);

    if (state.bannedUntil > now) {
      return {
        banned: true,
        retryAfterSec: Math.max(1, Math.ceil((state.bannedUntil - now) / 1000)),
        banCount: state.banCount,
      };
    }
    if (state.bannedUntil !== 0) {
      state.bannedUntil = 0;
      state.failures = [];
    }
    return { banned: false, retryAfterSec: 0, banCount: state.banCount };
  }

  recordFailure(key: string): BanDecision {
    const now = this.now();
    const cutoff = now - this.windowMs;

    let state = this.entries.get(key);
    this.entries.delete(key);
    if (state === undefined) {
      state = { failures: [], bannedUntil: 0, banCount: 0 };
    }

    if (state.bannedUntil > now) {
      this.entries.set(key, state);
      this.evictOverflow();
      return {
        banned: true,
        retryAfterSec: Math.max(1, Math.ceil((state.bannedUntil - now) / 1000)),
        banCount: state.banCount,
      };
    }
    if (state.bannedUntil !== 0) {
      state.bannedUntil = 0;
      state.failures = [];
    }

    const active = state.failures.filter((timestamp) => timestamp > cutoff);
    active.push(now);
    state.failures = active;

    if (this.limit > 0 && active.length >= this.limit) {
      state.banCount += 1;
      const durationSec = banDurationSec(state.banCount, this.banSec);
      state.bannedUntil = now + durationSec * 1000;
      state.failures = [];
      this.entries.set(key, state);
      this.evictOverflow();
      return {
        banned: true,
        retryAfterSec: durationSec,
        banCount: state.banCount,
      };
    }

    this.entries.set(key, state);
    this.evictOverflow();
    return { banned: false, retryAfterSec: 0, banCount: state.banCount };
  }

  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      this.entries.delete(oldest);
    }
  }
}

export interface CircuitBreakerDecision {
  open: boolean;
  openedNow: boolean;
  retryAfterSec: number;
}

export interface GlobalAuthFailureBreakerOptions {
  failureLimit: number;
  windowMs: number;
  cooldownMs: number;
  now?: () => number;
}

/**
 * Global authentication-failure circuit breaker.
 *
 * When too many failed authentications arrive across all client keys inside
 * the window, `/mcp` sheds traffic for the cooldown period. This catches
 * distributed brute force that per-key limits cannot see.
 */
export class GlobalAuthFailureBreaker {
  readonly failureLimit: number;
  readonly windowMs: number;
  readonly cooldownMs: number;
  private readonly now: () => number;
  private failures: number[] = [];
  private openUntil = 0;

  constructor(options: GlobalAuthFailureBreakerOptions) {
    this.failureLimit = Math.max(0, Math.floor(options.failureLimit));
    this.windowMs = Math.max(1, Math.floor(options.windowMs));
    this.cooldownMs = Math.max(1, Math.floor(options.cooldownMs));
    this.now = options.now ?? (() => Date.now());
  }

  state(): { open: boolean; retryAfterSec: number } {
    const now = this.now();
    if (this.openUntil > now) {
      return {
        open: true,
        retryAfterSec: Math.max(1, Math.ceil((this.openUntil - now) / 1000)),
      };
    }
    return { open: false, retryAfterSec: 0 };
  }

  recordFailure(): CircuitBreakerDecision {
    const now = this.now();
    if (this.openUntil > now) {
      return {
        open: true,
        openedNow: false,
        retryAfterSec: Math.max(1, Math.ceil((this.openUntil - now) / 1000)),
      };
    }
    this.openUntil = 0;

    const cutoff = now - this.windowMs;
    this.failures = this.failures.filter((timestamp) => timestamp > cutoff);
    this.failures.push(now);

    if (
      this.failureLimit > 0 && this.failures.length >= this.failureLimit
    ) {
      this.failures = [];
      this.openUntil = now + this.cooldownMs;
      return {
        open: true,
        openedNow: true,
        retryAfterSec: Math.max(1, Math.ceil(this.cooldownMs / 1000)),
      };
    }

    return { open: false, openedNow: false, retryAfterSec: 0 };
  }
}

export interface AbuseControls {
  config: AbuseConfig;
  limiter: SlidingWindowLimiter;
  authFailures: AuthFailureTracker;
  breaker: GlobalAuthFailureBreaker;
  /** Resolves the stable limiter key for an Express request. */
  clientKey(req: { ip?: string }): string;
}

/** Builds a fresh, isolated set of abuse controls. */
export function createAbuseControls(
  config: AbuseConfig,
  now: () => number = () => Date.now(),
): AbuseControls {
  return {
    config,
    limiter: new SlidingWindowLimiter({
      limit: config.rateLimitPerMin,
      windowMs: 60_000,
      maxEntries: config.maxTrackedKeys,
      now,
    }),
    authFailures: new AuthFailureTracker({
      limit: config.authFailLimit,
      windowMs: config.authFailWindowSec * 1000,
      banSec: config.authBanSec,
      maxEntries: config.maxTrackedKeys,
      now,
    }),
    breaker: new GlobalAuthFailureBreaker({
      failureLimit: config.globalAuthFailLimit,
      windowMs: config.globalAuthFailWindowSec * 1000,
      cooldownMs: config.globalBreakerCooldownSec * 1000,
      now,
    }),
    clientKey: (req) => normalizeClientIp(req.ip),
  };
}
