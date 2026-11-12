# Single-User TLS Proxy — Hardening Task List

Status: **implemented** in `feat/tls-single-user-hardening` (P0); P1 and owner decisions remain open.
Scope: **Tier 2 — one user behind a TLS-terminating reverse proxy** on a public
hostname. Goal: move the deployment from “B, adequate with conditions” to
“A−/B+, secure by default” without building team/SaaS identity features.

Source analysis: `/tmp/theo-audit/review/auth-internet.md` (auth review) and
[`SECURITY_AUDIT_2026-11-08.md`](./SECURITY_AUDIT_2026-11-08.md).
Already landed: F1–F9 fixes, 256-bit-token guidance, tier matrix, `/metrics`
and timeout documentation. The remaining work is mostly **posture, defaults,
and availability**, not a new auth protocol.

**Non-goals:** OAuth 2.1, per-token scopes, per-client audit, multi-tenant
isolation, multi-replica coordination, and an external IdP. Those are Tier 3/4
work; adding them here would make the single-user deployment heavier without
closing its actual gaps.

---

## Assumptions / owner decisions needed

- [ ] **D1** Is the TLS proxy on the same host as the app? (Assumed yes →
  `TRUST_PROXY=loopback`; if no, use the proxy's exact IP/CIDR.)
- [ ] **D2** Will `/metrics` be public at all? (Preferred: no; loopback or a
  separate token only.)
- [ ] **D3** Where does the token live? (Preferred: `0600` file or Docker
  secret, not a Compose `environment:` value.)
- [ ] **D4** Where do backups live, and what is the acceptable restore time?
- [ ] **D5** Does the MCP client support a manually configured
  `Authorization: Bearer` header? (If it requires OAuth discovery, this tier
  does not fit that client.)

Record answers in `SECURITY.md` or the deployment README before starting P0.

---

## P0 — required before exposing `/mcp` to the internet

### TLS-1 — Enforce a real 256-bit token, not just 32 characters
**Why:** the current floor accepts `"a".repeat(32)` and
`"passwordpasswordpasswordpassword"`; `MCP_ALLOW_WEAK_TOKEN=1` accepts a
1-character token.

Files: `logic/auth-tokens.ts`, `server.ts`, `.env.example`,
`test/auth-tokens.test.ts`, `test/startup-auth.test.ts`.

- [x] Require CSPRNG-grade tokens for env/file sources: a 32-char hard floor plus weak-pattern/distinct-character checks; warn for 32-42 non-hex and recommend 64+ hex/43+ base64url.
  43+ base64url characters (or a documented entropy check); reject repeated
  patterns and obvious passphrases.
- [x] Reject tokens containing commas/whitespace with a clear error instead of
  silently splitting a passphrase into multiple weak tokens.
- [x] Make `MCP_ALLOW_WEAK_TOKEN=1` emit a loud startup warning and refuse it
  when `HOST` is non-loopback (or require a second explicit override).
- [x] Tests: 32×`a` rejected; 43-char base64url accepted; passphrase rejected;
  weak override warns and is loopback-only; error never echoes the token.

### TLS-2 — Make the proxy trust posture safe by default
**Why:** behind a same-host proxy without `TRUST_PROXY`, every client appears as
`127.0.0.1`; one client's failures can lock out all clients. This was confirmed
with 10 spoofed `X-Forwarded-For` values followed by a valid token → `429`.

Files: `server.ts`, `logic/http-security.ts`, `SECURITY.md`, `.env.example`,
`test/http.test.ts`, `test/config.test.ts`.

- [x] Add `TRUST_PROXY=loopback` to the Caddy and nginx examples (not just the
  checklist).
- [x] At startup, warn when `HOST` is non-loopback and `TRUST_PROXY` is unset
  or `false`: “all clients will share the proxy IP; set TRUST_PROXY”.
- [x] Warn when `TRUST_PROXY=true` or `TRUST_PROXY=0.0.0.0/0` is used with a
  non-loopback bind (header spoofing defeats limits).
- [x] Tests: warning emitted/absent for the matrix; `parseTrustProxy` still
  rejects malformed values; `req.ip` stays the socket IP when trust is off.

### TLS-3 — Close the `/metrics` oracle
**Why:** `/metrics` requires the bearer token but bypasses the rate limiter,
lockout, and breaker; 100 bad tokens produced 100×`401`, 0×`429`. It is an
unthrottled token oracle and log-flood path.

Files: `server.ts`, `logic/abuse-controls.ts`, `SECURITY.md`, `.env.example`,
`test/http.test.ts`, `test/abuse-controls.test.ts`.

- [x] Add `MCP_METRICS_ENABLED` with a network-safe default: enabled on
  loopback, **disabled when `HOST` is non-loopback** unless explicitly
  `1/true/yes`.
- [x] Optional `MCP_METRICS_TOKEN`: a separate high-entropy token; when set,
  `/metrics` accepts only that token, never the `/mcp` token.
- [x] Apply a separate metrics rate limiter (e.g. 60/min per key) that does not
  share the `/mcp` bucket and does not trigger the auth-failure ban; return
  `429` with `Retry-After`.
- [x] Tests: non-loopback default is 404/403; opt-in works; separate token is
  isolated from `/mcp`; 61st scrape → 429; `/healthz` and `/mcp` unaffected.

### TLS-4 — Stop the global breaker from blocking valid tokens
**Why:** the breaker is checked before authentication. Five bad requests from
five IPs made a **valid** token receive `503`. This is an unauthenticated
all-client DoS lever.

Files: `server.ts`, `logic/abuse-controls.ts`, `test/http.test.ts`,
`test/abuse-controls.test.ts`.

- [x] Authenticate first, or exempt a token that has recently succeeded, or
  track per-key good/bad state so a valid bearer is not shed. Keep invalid
  traffic shed during an open breaker.
- [x] Preserve the anti-brute-force property: invalid tokens still get
  `503`/`429` promptly and do not reach expensive handlers.
- [x] Tests: valid token → 200 during breaker; invalid token → 503; breaker
  closes after cooldown; no `timingSafeEqual` bypass; load test does not
  regress.

### TLS-5 — Prefer file/secret tokens and reload without a restart
**Why:** Compose defaults pass the token in `environment:`, visible via
`docker inspect`/`/proc/<pid>/environ`. Removing a leaked token currently
requires a restart.

Files: `server.ts`, `logic/auth-tokens.ts`, `docker-compose.yml`,
`docker-compose.deploy.yml`, `.env.example`, `SECURITY.md`, tests.

- [x] Change Compose examples to `MCP_AUTH_TOKEN_FILE=/run/secrets/...` or
  Docker secrets; keep env support for local use.
- [x] Warn when a token comes from the environment while `HOST` is
  non-loopback.
- [x] Add `SIGHUP` reload of `MCP_AUTH_TOKEN_FILE` (atomic resolve; reject an
  empty/unreadable file and keep the old tokens). Document that rotation is
  overlap → SIGHUP → remove old.
- [x] Tests: SIGHUP adds a token; SIGHUP removes one; invalid file keeps old
  tokens and logs a warning; no token contents in logs.

### TLS-6 — Startup posture summary and warnings
**Why:** silent misconfiguration is the main Tier 2 risk.

Files: `server.ts`, `logic/logging.ts`, `SECURITY.md`, tests.

- [x] Emit one structured `security_posture` line at startup with: bind
  address, proxy trust, TLS assumption (`direct` vs `behind-proxy`), metrics
  status, token source (file/env/options, never the value), read-only mode,
  replica hint, and whether a backup path is configured.
- [x] Warn on: non-loopback bind, metrics reachable, weak override,
  `TRUST_PROXY=true`/wildcard, auth-off `createApp()`, missing `MCP_AUTH_TOKEN_FILE`
  when one is recommended, and `MCP_READ_ONLY` unknown values.
- [x] Tests: posture line rendered once; warnings are structured and contain no
  secrets; loopback defaults produce no scary warnings.

### TLS-7 — Readiness and stale-temp cleanup
**Why:** `/healthz` is liveness only; it says `ok` even if the todo file cannot
be loaded or serialized (the old F1 class). Killed writers can leave
`.uuid.tmp` files.

Files: `server.ts`, `logic/backends/local-file-backend.ts`,
`logic/todo-file-helpers.ts`, `test/http.test.ts`,
`test/local-file-durability.test.ts`.

- [x] Add `GET /readyz` that performs a bounded `backend.load()` +
  `serializeTodoContent()` and returns `503` on failure; keep `/healthz` cheap
  and unauthenticated.
- [x] Bound readiness with a short timeout (e.g. 2 s) so a hung backend does not
  hang the probe.
- [x] On startup, remove `.uuid.tmp` files older than a safe age in the todo
  directory; never delete recent temps that may belong to another writer.
- [x] Tests: unreadable/invalid UTF-8 file → `readyz` 503 while `healthz` 200; valid file →
  200; old temp removed, recent temp kept; read-only directory does not crash
  startup.

### TLS-8 — Concrete proxy reference configuration
**Why:** the example is what people copy. It currently omits
`TRUST_PROXY=loopback`, HSTS, body/connection limits, and `/metrics` blocking.

Files: `SECURITY.md`, `README.md`, `docker-compose.deploy.yml`, optional
`deploy/Caddyfile` + `deploy/nginx.conf`.

- [x] Caddy example: TLS, HTTP→HTTPS redirect, HSTS, request body limit 64 KiB,
  connection/header timeouts, rate limit, `reverse_proxy 127.0.0.1:3000`,
  `TRUST_PROXY=loopback`, `handle /metrics { respond 404 }` unless explicitly
  enabled.
- [x] nginx equivalent with `client_max_body_size 64k`,
  `proxy_set_header X-Forwarded-For`, `proxy_read_timeout`, and a `/metrics`
  deny rule.
- [x] Make the app port publish `127.0.0.1:3000` only; document that
  `HOST=0.0.0.0` is only for the private proxy hop.
- [x] Test: deployment lint/manual checklist; Compose YAML parsed with Node (Docker unavailable here) and both configs were reviewed.
  `docker-compose.deploy.yml` and verify `docker compose config`.

### TLS-9 — Backup, restore, and log retention
**Why:** any valid token can delete or corrupt the only file; Compose has no
log-size limit.

Files: `docker-compose.yml`, `docker-compose.deploy.yml`, `SECURITY.md`,
`README.md`, optional `bin/backup-todo.sh`.

- [x] Add Compose logging limits (`max-size`, `max-file`) for both services.
- [x] Document a backup/restore procedure: snapshot before upgrades, keep N
  versions, verify with `list_todos`, restore while the app is stopped.
- [ ] Optional: checksum/parse guard before replace; snapshot-on-write with
  retention; expose a `TODOTXT_MCP_BACKUP_DIR`.
- [ ] Test: backup script creates a readable copy; restore round-trip; malformed
  snapshot is refused.

### TLS-10 — Operator runbook and client guidance
**Why:** the remaining risks are operational: leakage, rotation, revocation,
restore, and clients expecting OAuth discovery.

Files: `SECURITY.md`, `README.md`, `.env.example`.

- [x] Document: static bearer is **not** OAuth 2.1/MCP discovery; configure the
  client's `Authorization` header explicitly; never put tokens in URLs.
- [x] Rotation runbook: overlap token → `SIGHUP`/restart → verify → remove old.
- [x] Revocation: edit token file → `SIGHUP`; if SIGHUP is not available,
  restart and confirm the old token is `401`.
- [x] Incident: rotate immediately, inspect `401`/`429`/breaker logs, restore
  from backup if the file was modified.
- [x] Mark `HARDENING_TASKLIST.md` as historical/superseded; add log-redaction
  and proxy-log-retention guidance.

---

## P1 — worthwhile after P0

- [ ] **TLS-11** Separate loopback-only metrics listener (or mTLS on the proxy
  hop) so `/metrics` never shares the public listener.
- [ ] **TLS-12** Alert rules for `401`/`429` spikes, breaker opens, readiness
  failures, and disk usage; document the thresholds.
- [ ] **TLS-13** Optional per-token labels (not scopes) for “which client is
  this?” logging; keep one full-access scope.
- [ ] **TLS-14** Token hash-at-rest (store SHA-256 of tokens in the file) if the
  secret file is on shared storage. This is not a substitute for file mode.

---

## Sequencing

1. **TLS-1, TLS-2, TLS-5** — token/proxy/secret basics (small, low risk).
2. **TLS-3, TLS-4** — remove the two confirmed availability/security levers.
3. **TLS-6, TLS-7** — make misconfiguration and backend failure visible.
4. **TLS-8, TLS-9, TLS-10** — copy-paste deployment, backup, and runbook.
5. **P1** only after a real deployment has run P0 for a while.

Do **not** start TLS-11–14 before P0; they add surface without closing the
confirmed Tier 2 gaps.

---

## Definition of done

- [x] All P0 tasks implemented with red-first tests where code changes.
- [x] `npm run typecheck && npm test` green; new tests cover the warnings,
  `/metrics` default, breaker-valid-token case, SIGHUP reload, `/readyz`, and
  temp cleanup.
- [ ] `docker compose config` valid; Compose uses a secret/file token and log
  limits.
- [x] `SECURITY.md` tier table and examples match the implemented behavior.
- [x] A fresh deployment can follow the docs without setting an undocumented
  variable; no step requires reading source.
- [x] Residual risk recorded: one token = full file control; no per-client
  revocation/expiry/audit; global-breaker DoS mitigated but not eliminated;
  single replica only.
