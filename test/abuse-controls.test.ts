import { describe, expect, it } from "vitest";
import {
  AuthFailureTracker,
  BAN_BACKOFF_LADDER_SEC,
  banDurationSec,
  DEFAULT_ABUSE_CONFIG,
  GlobalAuthFailureBreaker,
  MAX_BAN_SEC,
  normalizeClientIp,
  resolveAbuseConfig,
  SlidingWindowLimiter,
  UNKNOWN_CLIENT_KEY,
} from "../logic/abuse-controls.ts";

describe("client key normalization", () => {
  it("falls back for missing or empty addresses", () => {
    expect(normalizeClientIp(undefined)).toBe(UNKNOWN_CLIENT_KEY);
    expect(normalizeClientIp(null)).toBe(UNKNOWN_CLIENT_KEY);
    expect(normalizeClientIp("")).toBe(UNKNOWN_CLIENT_KEY);
    expect(normalizeClientIp("   ")).toBe(UNKNOWN_CLIENT_KEY);
  });

  it("keeps IPv4 addresses and strips the IPv4-mapped prefix", () => {
    expect(normalizeClientIp("127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeClientIp("203.0.113.9")).toBe("203.0.113.9");
    expect(normalizeClientIp("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeClientIp("::FFFF:203.0.113.9")).toBe("203.0.113.9");
  });

  it("keys IPv6 clients by their /64 prefix and lowercases hex", () => {
    expect(normalizeClientIp("2001:DB8:0:1:aaaa:bbbb:cccc:dddd"))
      .toBe("2001:db8:0:1::/64");
    expect(normalizeClientIp("2001:db8:0:1::1")).toBe("2001:db8:0:1::/64");
    expect(normalizeClientIp("[2001:db8::1]:443")).toBe(
      "2001:db8:0:0::/64",
    );
    expect(normalizeClientIp("::1")).toBe("0:0:0:0::/64");
    // Same /64 for two different hosts inside it.
    expect(normalizeClientIp("2001:db8:abcd:12::1"))
      .toBe(normalizeClientIp("2001:db8:abcd:12:ffff::99"));
  });

  it("falls back for values that are not IP literals", () => {
    expect(normalizeClientIp("not an ip")).toBe("not an ip");
  });
});

describe("sliding-window limiter", () => {
  it("allows up to the limit and then rejects with Retry-After", () => {
    let now = 1_000;
    const limiter = new SlidingWindowLimiter({
      limit: 2,
      windowMs: 60_000,
      now: () => now,
    });

    expect(limiter.check("key")).toMatchObject({
      allowed: true,
      limit: 2,
      remaining: 1,
      retryAfterSec: 0,
    });
    expect(limiter.check("key")).toMatchObject({
      allowed: true,
      remaining: 0,
    });
    expect(limiter.check("key")).toMatchObject({
      allowed: false,
      remaining: 0,
      retryAfterSec: 60,
    });

    now += 60_001;
    expect(limiter.check("key").allowed).toBe(true);
  });

  it("slides the window instead of resetting all hits at once", () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter({
      limit: 2,
      windowMs: 10_000,
      now: () => now,
    });

    expect(limiter.check("key").allowed).toBe(true); // t=0
    now = 5_000;
    expect(limiter.check("key").allowed).toBe(true); // t=5s
    now = 6_000;
    expect(limiter.check("key").allowed).toBe(false);

    now = 10_001; // t=0 entry expires, t=5s remains
    expect(limiter.check("key").allowed).toBe(true);
    expect(limiter.check("key").allowed).toBe(false);
  });

  it("disables itself when the limit is zero", () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter({
      limit: 0,
      windowMs: 60_000,
      now: () => now,
    });

    for (let index = 0; index < 100; index += 1) {
      now += 1;
      expect(limiter.check("key").allowed).toBe(true);
    }
    expect(limiter.size).toBe(0);
  });

  it("stays bounded when a client rotates through many keys", () => {
    const limiter = new SlidingWindowLimiter({
      limit: 5,
      windowMs: 60_000,
      maxEntries: 100,
      now: () => 1,
    });

    for (let index = 0; index < 5_000; index += 1) {
      limiter.check(`rotating-${index}`);
    }

    expect(limiter.size).toBeLessThanOrEqual(100);
  });

  it("prunes keys whose last hit left the window", () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter({
      limit: 3,
      windowMs: 1_000,
      now: () => now,
    });

    limiter.check("a");
    limiter.check("b");
    expect(limiter.size).toBe(2);

    now = 2_000;
    limiter.pruneExpired();
    expect(limiter.size).toBe(0);
  });
});

describe("auth failure tracker", () => {
  it("bans after the configured number of failures and expires the ban", () => {
    let now = 0;
    const tracker = new AuthFailureTracker({
      limit: 3,
      windowMs: 900_000,
      banSec: 60,
      now: () => now,
    });

    expect(tracker.recordFailure("key").banned).toBe(false);
    expect(tracker.recordFailure("key").banned).toBe(false);
    expect(tracker.recordFailure("key")).toMatchObject({
      banned: true,
      retryAfterSec: 60,
      banCount: 1,
    });
    expect(tracker.getBan("key")).toMatchObject({
      banned: true,
      retryAfterSec: 60,
    });

    now = 60_001;
    expect(tracker.getBan("key").banned).toBe(false);
    // After expiry, the failure window starts over.
    expect(tracker.recordFailure("key").banned).toBe(false);
  });

  it("resets the failure counter after a successful authentication", () => {
    const tracker = new AuthFailureTracker({
      limit: 3,
      windowMs: 900_000,
      banSec: 60,
    });

    tracker.recordFailure("key");
    tracker.recordFailure("key");
    tracker.recordSuccess("key");

    expect(tracker.recordFailure("key").banned).toBe(false);
    expect(tracker.recordFailure("key").banned).toBe(false);
    expect(tracker.recordFailure("key").banned).toBe(true);
  });

  it("escalates repeat offenders up to a one-hour cap", () => {
    expect(banDurationSec(1, 60)).toBe(60);
    expect(banDurationSec(2, 60)).toBe(300);
    expect(banDurationSec(3, 60)).toBe(900);
    expect(banDurationSec(4, 60)).toBe(3_600);
    expect(banDurationSec(10, 60)).toBe(MAX_BAN_SEC);
    expect(BAN_BACKOFF_LADDER_SEC).toEqual([60, 300, 900, 3_600]);

    let now = 0;
    const tracker = new AuthFailureTracker({
      limit: 1,
      windowMs: 60_000,
      banSec: 60,
      now: () => now,
    });

    expect(tracker.recordFailure("key").retryAfterSec).toBe(60);
    now = 60_001;
    expect(tracker.recordFailure("key").retryAfterSec).toBe(300);
    now += 300_001;
    expect(tracker.recordFailure("key").retryAfterSec).toBe(900);
    now += 900_001;
    expect(tracker.recordFailure("key").retryAfterSec).toBe(3_600);
  });

  it("stays bounded under many keys", () => {
    const tracker = new AuthFailureTracker({
      limit: 5,
      windowMs: 60_000,
      banSec: 60,
      maxEntries: 50,
    });

    for (let index = 0; index < 1_000; index += 1) {
      tracker.recordFailure(`rotating-${index}`);
    }

    expect(tracker.size).toBeLessThanOrEqual(50);
  });
});

describe("global authentication failure breaker", () => {
  it("opens at the threshold, sheds traffic, and closes after the cooldown", () => {
    let now = 0;
    const breaker = new GlobalAuthFailureBreaker({
      failureLimit: 3,
      windowMs: 60_000,
      cooldownMs: 120_000,
      now: () => now,
    });

    expect(breaker.recordFailure()).toMatchObject({
      open: false,
      openedNow: false,
    });
    expect(breaker.recordFailure()).toMatchObject({
      open: false,
      openedNow: false,
    });
    expect(breaker.recordFailure()).toMatchObject({
      open: true,
      openedNow: true,
      retryAfterSec: 120,
    });
    expect(breaker.state()).toMatchObject({ open: true });

    now = 60_000;
    expect(breaker.state()).toMatchObject({
      open: true,
      retryAfterSec: 60,
    });

    now = 120_001;
    expect(breaker.state().open).toBe(false);
    expect(breaker.recordFailure()).toMatchObject({
      open: false,
      openedNow: false,
    });
  });
});

describe("abuse config", () => {
  it("uses the documented defaults", () => {
    expect(resolveAbuseConfig({}, {})).toEqual(DEFAULT_ABUSE_CONFIG);
    expect(DEFAULT_ABUSE_CONFIG).toMatchObject({
      rateLimitPerMin: 60,
      authFailLimit: 10,
      authFailWindowSec: 900,
      authBanSec: 900,
      maxConcurrency: 20,
    });
  });

  it("reads environment variables and allows zero to disable limits", () => {
    expect(resolveAbuseConfig({
      MCP_RATE_LIMIT_PER_MIN: "0",
      MCP_AUTH_FAIL_LIMIT: "4",
      MCP_AUTH_FAIL_WINDOW_SEC: "120",
      MCP_AUTH_BAN_SEC: "300",
      MCP_MAX_CONCURRENCY: "3",
    }, {})).toMatchObject({
      rateLimitPerMin: 0,
      authFailLimit: 4,
      authFailWindowSec: 120,
      authBanSec: 300,
      maxConcurrency: 3,
    });
  });

  it("prefers explicit overrides and ignores invalid values", () => {
    expect(resolveAbuseConfig({
      MCP_RATE_LIMIT_PER_MIN: "not-a-number",
      MCP_AUTH_FAIL_LIMIT: "-1",
    }, {
      rateLimitPerMin: 12,
      authFailLimit: 2,
    })).toMatchObject({
      rateLimitPerMin: 12,
      authFailLimit: 2,
      authFailWindowSec: DEFAULT_ABUSE_CONFIG.authFailWindowSec,
    });
  });
});
