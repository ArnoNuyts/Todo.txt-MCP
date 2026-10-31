# Internet-Readiness Hardening Tasklist

Assessment date: 2026-10-31 · Scope: `server.ts`, `logic/http-security.ts`, backends, deployment.

## Verdict

**Do not expose this directly to the open internet today.** It is a well-built
*local-first* MCP server, but it is missing the controls that matter the moment
a public IP or a port-forward is involved: rate limiting, auth-failure lockout,
request/concurrency timeouts, proxy awareness, and auditability.

| Scenario | Verdict |
| --- | --- |
| Loopback only, as shipped | **Safe.** Good defaults (Host/Origin allowlist, 64 KiB cap, loopback bind). |
| Exposed via TLS proxy with a strong `MCP_AUTH_TOKEN` | **Workable for one user**, but still brute-forceable and DoS-able. |
| Exposed with no token (current default when unset) | **No.** Anyone who finds `/mcp` can read, edit, complete, and delete every todo. |
| Multi-client / multi-user / multi-replica | **No.** One shared static token, in-process-only lock, no per-client identity. |

Score: **local-first 8/10, public internet 3/10** — mostly a missing
operational layer, not a broken design.

### What already holds up

- Constant-time token comparison, no token → 401, uniform error body.
- Host validation (DNS rebinding) and explicit Origin allowlist; no CORS `*`.
- 64 KiB body cap, stateless transport, JSON responses (no hang-open SSE).
- Atomic file writes; WebDAV requires HTTPS except loopback; `If-Match` used.
- Container runs non-root, read-only FS, `cap_drop: ALL`, `no-new-privileges`.
- Pinned CI actions, Dependabot, `npm audit --audit-level=high`.
- `withBackendLock` correctly serializes load → mutate → save per process.

### The gaps that decide "survive the internet"

1. **No rate limiting at all.** A single client can issue unlimited requests.
2. **No auth-failure counter, backoff, or ban.** A static bearer token can be
   brute-forced forever at network speed; the only cost per guess is a
   SHA-256 compare.
3. **No request/header/concurrency timeouts.** Slowloris and queue-flooding
   (many concurrent `add_todo` calls pile up behind the in-process lock).
4. **No proxy awareness.** Behind Caddy/nginx, `req.ip` is the proxy, so a
   naive per-IP limiter either bans everyone or is bypassed via `X-Forwarded-For`.
5. **Single static shared secret.** No rotation window, no per-client tokens,
   no scopes, no revocation, no audit of which client changed what.
6. **Length leak in `tokensEqual`.** Early return on length mismatch is a minor
   timing oracle; hash both sides to fixed length instead.
7. **No security headers, request IDs, access logs, or 401/429 metrics.** You
   would not know you were under attack.
8. **Process-local lock only.** Two replicas or two containers race on the same
   file. WebDAV `412` is surfaced as an error instead of retried.
9. **No capacity limits.** Todo file size, total todos, and list search cost are
   unbounded; every request re-reads and re-hashes the whole file.

---

## P0 — Must have before any public exposure

- [ ] **Per-IP rate limiter on `/mcp`** (and a separate stricter bucket for auth
      failures). Suggested starting point: 60 requests/min, burst 20, keyed by
      normalized client IP.
      - Bounded store (LRU + TTL, e.g. max 10k keys) so the limiter itself
        cannot be memory-DoSed by rotating source addresses.
      - Normalize IPv6 to `/64`; do not key on raw full address.
      - Emit `Retry-After` and `RateLimit-*` headers.
- [ ] **Auth-failure lockout.** 10 failed attempts per IP per 15 min → HTTP 429
      (JSON-RPC error body, code `-32000`) with `Retry-After`, exponential
      backoff on repeat (1m → 5m → 15m → 1h), auto-expire. Prefer temporary
      bans over permanent ones: the token is shared, so a permanent IP ban can
      lock out NATed users.
      - Reset the failure counter on a successful auth.
      - Apply the same 401 body for missing, malformed, and wrong tokens.
- [ ] **Global 401 circuit breaker.** e.g. >100 failed auths/min across all IPs →
      temporarily shed `/mcp` traffic (503/429) and log loudly. Per-IP limits
      alone do not stop a distributed brute force.
- [ ] **Trust-proxy configuration.** Add `TRUST_PROXY` (default `false`; accept
      `1`, `loopback`, or a CIDR list). Wire it to `app.set("trust proxy", …)`.
      Document that enabling it without a real proxy allows `X-Forwarded-For`
      spoofing and defeats the limiter. Never trust XFF by default.
- [ ] **Server timeouts.** Set `server.requestTimeout` (~15 s),
      `server.headersTimeout` (~10 s), and `server.keepAliveTimeout` (~5 s)
      after `listen()`. Confirm oversized slow bodies are cut off, not buffered.
- [ ] **Bounded request concurrency / queue.** Cap in-flight `/mcp` work
      (e.g. 20) and reject beyond it with 503 + `Retry-After`. Prevents the
      backend lock queue from growing without limit.
- [ ] **Tests for all of the above** (`test/http.test.ts`):
      - N failures → 429; succeeding before N → counter resets.
      - `Retry-After` present and ban expires (fake timers).
      - 429 does not affect `/healthz`.
      - Spoofed `X-Forwarded-For` ignored when `trust proxy` is off.
      - Limiter map stays bounded under 100k unique keys.
      - Concurrency cap returns 503 instead of queueing forever.
- [ ] **Update `SECURITY.md` + `.env.example`** with the new variables, ban
      semantics, and a "if you expose this publicly" checklist.

## P1 — Should have for a real deployment

- [ ] **Token hardening.**
      - Hash both sides with SHA-256/HMAC before `timingSafeEqual` so lengths
        always match.
      - Support multiple active tokens (`MCP_AUTH_TOKENS`) for zero-downtime
        rotation; optionally `SIGHUP` reload from `MCP_AUTH_TOKEN_FILE`.
      - Reject tokens shorter than 32 random bytes at startup (fail fast).
      - Optional `MCP_READ_ONLY=1` to deny mutating tools without redeploying.
- [ ] **Abuse-resistant logging.**
      - JSON access log: timestamp, request ID, method, status, duration, client
        IP, auth result, tool name. Never log the token or todo contents.
      - Warn/critical log lines on 401 bursts, 429s, and backend errors.
      - Document log retention; avoid unbounded disk growth.
- [ ] **Metrics.** Counters for requests, 401, 429, 5xx, lock wait time, and
      tool calls. Expose on an authenticated `/metrics` or ship to the proxy.
      Alert on 401 spikes.
- [ ] **Security headers.** `app.disable("x-powered-by")`, add
      `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and
      `Cache-Control: no-store` on `/mcp`. Add HSTS at the TLS proxy.
- [ ] **Input hardening.** Reject non-`application/json` POSTs early; enforce a
      hard cap on todo file size (e.g. 1 MB) and total todo count; abort list
      search beyond a sane file size; return a clear error instead of OOM.
- [ ] **Cross-process safety.** Either document "one replica only" prominently,
      or add an OS-level lock (or a small SQLite/Redis coordination layer).
      For WebDAV, retry `412` by re-reading and re-applying the mutation once or
      twice with jitter instead of failing the tool call.
- [ ] **Healthcheck/port bug.** The Dockerfile and both Compose healthchecks
      hardcode port 3000; use `$PORT` or document that overriding `PORT`
      breaks health checks.
- [ ] **Container limits.** Add `mem_limit`, `pids_limit`,
      `restart: unless-stopped`, and read-only secret mounts (Docker secrets)
      instead of `MCP_AUTH_TOKEN` in `environment`. Env vars are visible via
      `docker inspect`.
- [ ] **CI hardening.** Add CodeQL/SAST, a container scan (Trivy/Grype), and
      `npm audit --audit-level=moderate`. Add a test that asserts default bind
      is loopback and that auth is required when a token is configured.

## P2 — Nice to have / roadmap

- [ ] **Move from a shared static bearer token to MCP OAuth 2.1** (or signed,
      per-client tokens with expiry and scopes `read` / `write` / `admin`).
      This is the real answer for multiple clients and revocation.
- [ ] **Audit trail for mutations.** Append-only JSONL (or SQLite) recording
      tool, hash, timestamp, and token identity — invaluable after an incident.
- [ ] **Per-token / per-IP quotas** (e.g. 1k tool calls/hour) on top of the
      generic request limiter.
- [ ] **Backup/restore + corruption detection.** Keep the last N versions of
      `todo.txt` (or snapshot on write) so a bad agent cannot destroy the file.
      Add a checksum/parse guard before rename.
- [ ] **Read-only demo mode** and a public sandbox if this is ever hosted.
- [ ] **Load test** (`autocannon`/`k6`): verify 429/503 behavior, memory stays
      flat under sustained load, and p99 latency with a 100k-line todo file.
- [ ] **Docs.** Add `delete_todo` to the README tool list; add a "public
      deployment reference architecture" (proxy rate limits + TLS + token
      rotation + monitoring).

## Suggested config surface

| Variable | Default | Purpose |
| --- | --- | --- |
| `TRUST_PROXY` | `false` | Express trust proxy; required behind Caddy/nginx |
| `MCP_RATE_LIMIT_PER_MIN` | `60` | Requests per IP per minute |
| `MCP_AUTH_FAIL_LIMIT` | `10` | Failed auths before lockout |
| `MCP_AUTH_FAIL_WINDOW_SEC` | `900` | Failure counting window |
| `MCP_AUTH_BAN_SEC` | `900` | Initial lockout duration (exponential after) |
| `MCP_MAX_CONCURRENCY` | `20` | In-flight `/mcp` requests before 503 |
| `MCP_AUTH_TOKENS` | unset | Comma-separated tokens for rotation |
| `MCP_READ_ONLY` | `false` | Disable mutating tools |

## Definition of done

- `npm run typecheck && npm test -- --coverage` green, with new limiter/lockout
  tests included.
- `curl` drills pass: 10 bad tokens → 429 with `Retry-After`; correct token
  during the ban still gets 429; after expiry it works; `/healthz` stays 200.
- A 5-minute `autocannon` run at 500 rps produces 429/503 (not crashes), flat
  RSS, and no unbounded limiter growth.
- `SECURITY.md` accurately describes the public-exposure posture and limits.
