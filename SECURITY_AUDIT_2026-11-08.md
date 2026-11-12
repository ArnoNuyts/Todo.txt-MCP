# Security Audit — Theo (`todo.txt-mcp`) — 2026-11-08

**Target:** `/home/t3/.t3/worktrees/todo-txt-mcp/t3-51606b13` (`@arnoarnoarno/todo.txt-mcp` v3.2.0, commit `80ec6ad`)
**Runtime:** Node `v24.22.2` (native TypeScript), Linux, non-root user `t3`
**Method:** 4 parallel subagents — HTTP-claim verification, data-claim verification,
HTTP/MCP protocol fuzzing, and domain fuzzing — followed by independent
reproduction of every medium finding by the lead agent.
**Baseline:** `npm test` → **34 files / 364 tests passed** before the audit.
**Repo impact:** audit only. No source files were changed by the audit. Raw
evidence lives under `/tmp/theo-audit/` (see [Artifacts](#artifacts)).

> **Remediation status (2026-11-08):** F1–F9 are fixed in the working tree with
> red-first regression tests, and F10–F17 are documented or accepted as
> residual risk. See [TDD_FIX_TASKLIST.md](./TDD_FIX_TASKLIST.md) for the fixes,
> review verdicts, and final `407`-test verification.

---

## 1. Claim list and verdicts

The claims below are taken from `SECURITY.md` and `README.md`. Verdicts are based
on source review **and** live probes, not on the existing test suite alone.

| # | Claim | Verdict | Short evidence |
|---|-------|---------|----------------|
| C1 | Authentication is mandatory; weak env/file tokens (<32 chars) are rejected unless `MCP_ALLOW_WEAK_TOKEN=1`; precedence is file > list > single | **PASS** | No source → exit 1; 31-char token → exit 1; 32-char → serves; file beats list beats single (live) |
| C2 | `/mcp` and `/metrics` require `Bearer`; missing/malformed/wrong tokens all get the same 401 JSON-RPC body; comparison is constant-time | **PASS** | Five different failure modes produced byte-identical `-32001` bodies; `SHA-256` + `timingSafeEqual` over fixed 32-byte digests |
| C3 | Host allowlist stops DNS rebinding; ports ignored; missing/invalid Host → 403 | **PASS** | `localhost:9999`, `LOCALHOST`, `[::1]:3000` accepted; `localhost.`, `127.0.0.1.evil.com`, `evil.com`, malformed and missing Host → 403 |
| C4 | Origin allowlist only allows configured origins; empty list disables CORS; never emits `Access-Control-Allow-Origin: *` | **PARTIAL** | Core POST `/mcp` behavior correct, but Origin is **only** checked for `POST /mcp`; other methods/paths rely on CORS header omission |
| C5 | Request bodies capped at 64 KiB; non-JSON POSTs rejected | **PASS (caveat)** | 65,536 B → 200, 65,537 B → 413; `text/plain`/`text/json`/`application/jsonx` → 415; **missing Content-Type is accepted** by design |
| C6 | 60 req/min per key; 10 auth failures → 429; correct token stays banned; bans expire; global breaker 100/60s → 503; concurrency 20 → 503; 15s/10s/5s timeouts | **PASS (nuance)** | All behaviors confirmed; Node's 30 s checker tick means slow headers/body are cut at **~30 s**, not 10/15 s |
| C7 | `/healthz` unauthenticated; `/metrics` token-protected; security headers on `/mcp` and `/metrics`; no `X-Powered-By`; GET/DELETE `/mcp` → 405 | **PASS** | Confirmed, including during an active auth ban; `/healthz` is still Host-validated |
| C8 | `MCP_READ_ONLY` registers only `list_todos`; mutations are absent from `tools/list` and uncallable | **PASS** | `1/true/yes` → only `list_todos`; direct mutation calls → `-32602`; resources/prompt remain; `readOnly:false` overrides |
| C9 | Structured logs never contain tokens, request bodies, or todo content; request IDs are validated | **PASS** | 1,341-request HTTP fuzz and 457-call domain fuzz produced no token/body/todo canary in logs; IDs match `[A-Za-z0-9._-]{1,128}` |
| C10 | Atomic local writes, serialized mutations, 1 MiB/10k limits, single-line input validation, byte-stable round-trips | **PARTIAL** | Atomicity/locking/limits mostly hold; **invalid-date lockout**, **recurrence limit bypass**, WebDAV redirect handling, and some validation edges fail |

### Interpretation

- **8 PASS**, **2 PARTIAL**. The core security posture described in `SECURITY.md`
  is accurate for the HTTP boundary: auth, Host/Origin, body caps, abuse
  controls, headers, read-only mode, and log hygiene all held under probing.
- The PARTIAL verdicts are not cosmetic: C10 contains the two medium-severity
  findings below, and C4 is a documentation overstatement, not an auth bypass.

---

## 2. Findings

Severity: **Medium** = availability lockout or a documented safety limit not
enforced. **Low** = validation/robustness/docs gap. **Info** = defensible but
worth documenting.

| ID | Sev | Finding | Evidence / repro |
|----|-----|---------|------------------|
| **F1** | **Medium** | **Impossible calendar date locks the whole service.** A pre-existing line like `2024-13-01 task` matches the parser regex but creates an invalid `Date`. Serializing it throws `RangeError: Invalid time value`, so `list_todos`, `add_todos`, `update_todos`, and `delete_todos` all fail. No hash can be computed, so no tool can repair the file. | Confirmed: all four tools returned `BACKEND_ERROR: Invalid time value`; file unchanged. Root cause `logic/todo.ts:15-18,61-70,145-164`; `formatDate` calls `toISOString()` on an invalid date. Repro: `/tmp/theo-audit/fuzz-domain/repros/date-lockout.ts` |
| **F2** | **Medium** | **`TODOTXT_MCP_MAX_TODOS` is bypassed by recurrence.** The cap is checked only in `add_todos`. Completing a recurring todo through `update_todos` appends a follow-up without checking the limit. Repeated completions can grow past the configured maximum (bounded eventually by the 1 MiB file cap). | Confirmed: limit 5 + 5 todos → recurring completion persisted **6** lines; a sixth `add_todos` was correctly refused. `logic/tools.ts:255-274` vs `:399-410`. Repro: `/tmp/theo-audit/fuzz-domain/repros/limit-recurrence.ts` |
| **F3** | Low | **WebDAV `load()` follows redirects.** GET uses default `redirect:"follow"`; PUT and the write-probe GET use `redirect:"manual"`. A redirecting proxy can change what is parsed as the todo file. | `logic/backends/webdav-backend.ts:304-307` vs `:390` and `:516-517`; loopback 302 was followed and its body parsed. |
| **F4** | Low | **Malformed update echoes the full payload.** `parseTextUpdate` interpolates the whole line into the error message. A 2,000-char update produced a 2,045-char error containing the input. Other validators deliberately avoid echoing input. | `logic/tools.ts:299-307`; repro: `/tmp/theo-audit/fuzz-domain/repros/error-echo.ts` |
| **F5** | Low | **Invalid dates via `add_todos` return `BACKEND_ERROR`, and impossible days are silently normalized.** `2024-13-01 task` errors; `x 2024-02-30 task` is stored as `x 2024-03-01 <today> task`. | Same root cause as F1; repro: `/tmp/theo-audit/fuzz-domain/repros/invalid-date-add.ts` |
| **F6** | Low | **Whitespace-only todos are accepted.** `add_todos(["   "])` stores an invisible row that cannot be updated (empty body after trim), only deleted. | Repro: `/tmp/theo-audit/fuzz-domain/repros/whitespace-todo.ts` |
| **F7** | Low | **Two-date line silently loses a field on edit.** `2024-01-01 2024-02-02 task` updated to `task edited` becomes `2024-02-02 task edited`; the first date is dropped. Untouched lines are byte-preserved, so this only affects modified rows. | Repro: `/tmp/theo-audit/fuzz-domain/repros/two-date-edit.ts` |
| **F8** | Low | **Recurrence month/year overflow is surprising.** `due:2026-01-31 rec:+1m` → `2026-03-03`; `due:2024-02-29 rec:+1y` → `2025-03-01`. A huge `rec:+999999999d` gives `BACKEND_ERROR`, not `INVALID_ARGUMENT`. | `logic/recurrence.ts` uses JS `Date` arithmetic; repro: `/tmp/theo-audit/fuzz-domain/repros/recurrence-calendar.ts` |
| **F9** | Low | **WebDAV parses HTML/XML mislabeled as `text/plain`.** `looksLikeHtml` is skipped when the media type is exactly `text/plain`, so a proxy error page with that label is accepted as todos. | `logic/backends/webdav-backend.ts:359`; mocked-fetch probe. |
| **F10** | Low | **`/metrics` is an unthrottled auth oracle.** It bypasses the `/mcp` rate limiter, lockout, and global breaker by design; unlimited token guesses return 401. Practical risk is low because tokens must be ≥32 chars. | `server.ts:582-596`; 20 bad `/metrics` tokens → 20×401, no 429; breaker with limit 2 not tripped. |
| **F11** | Low (docs) | **"Any Origin → 403" is broader than the implementation.** Origin is enforced only by the MCP transport on `POST /mcp`. Evil-Origin `OPTIONS/GET/DELETE /mcp`, `/healthz`, and `/metrics` are not rejected — though none reflects the origin or emits `ACAO: *`, so browsers still cannot read them. | `SECURITY.md:37-42`; probe matrix in `/tmp/theo-audit/http-claims/`. |
| **F12** | Low (docs/ops) | **Timeout values are set but enforced at ~30 s.** `requestTimeout=15s`, `headersTimeout=10s`, `keepAliveTimeout=5s` are configured, but Node's `ConnectionsChecker` runs every 30 s by default. Slow headers and slow bodies were cut at ~30.0 s. | `server.ts:820-823`; control with `connectionsCheckingInterval=250ms` honored a 2 s timeout at 2.007 s. |
| **F13** | Info | **Unknown truthy `MCP_READ_ONLY` values fail open.** Only `1/true/yes` enable read-only; `on`, `yes!`, `truee` silently leave write tools enabled. | `server.ts:100-109`; probe `truee` → all 4 tools. |
| **F14** | Info | **No `fsync`.** Writes are atomic (temp + rename, proven under concurrent readers and SIGKILL) but not power-loss durable; killed writers leave `.uuid.tmp` litter. Only `0o777` mode bits are preserved (no owner/ACL/xattr). | `logic/todo-file-helpers.ts:156-179`; SIGKILL probe. |
| **F15** | Info | **Schema-bound violations use `-32602` without a structured code.** E.g. 101 items or a 2,001-char todo returns SDK `Input validation error` and no `structuredContent.error.code`, unlike handler-level `INVALID_ARGUMENT`/`LIMIT_EXCEEDED`. | `test`/fuzz probe; `logic/tools.ts:25-41`. |
| **F16** | Info | **Bidi controls are accepted and echoed.** U+202A–U+202E/U+2066–U+2069 can visually reorder terminal/chat output. They remain a single physical line, so this is display spoofing, not injection. | `/tmp/theo-audit/fuzz-domain/repros/bidi-accepted.ts`. |
| **F17** | Info (docs) | **Auth-disabled wording contradicts mandatory auth.** `SECURITY.md` says "when authentication is disabled the endpoint is open", but startup refuses without a token; only the exported `createApp()` can run auth-off. Missing `Content-Type` acceptance and `/healthz` Host validation are also undocumented. | `SECURITY.md:199-200` vs `:51-52,95-97`; probes. |

### Confirmed fuzz coverage

| Area | Volume | Result |
|------|--------|--------|
| HTTP/MCP protocol fuzz | 3 seeds, **1,341 requests** (cap 5,000), 56 handcrafted + 150 mutated JSON-RPC bodies, 243 HTTP cases, concurrency 12, bodies ≤70 KiB | **0 crashes, hangs, unhandled rejections, stack traces, auth/Host/Origin bypasses, smuggling, or limit bypasses.** `/healthz`, authenticated `initialize`, and `/metrics` still worked after each run. |
| Domain fuzz | **457 tool calls** (cap 3,000), seeded `0x5eed2026`, 70 random operation sequences, 50-way concurrency, hostile pre-existing files | 0 transport throws; no newline/control/surrogate injection; strict UTF-8; stable hashes; no lost updates; duplicate adds idempotent. Findings F1–F9 above. |
| Existing suite | Full `npm test` | **364/364 passed**; targeted data suite **121/121 passed**. The findings are untested edges, not regressions. |

---

## 3. Prioritized recommendations

1. **Fix date handling (F1, F5, F8).** Validate calendar dates when parsing instead
   of only matching `\d{4}-[0-1]\d-[0-3]\d`; represent invalid/unparseable dates as
   raw text rather than an invalid `Date`; never let `toString()` throw for a
   loaded line. Reject impossible dates on `add_todos`/`update_todos` as
   `INVALID_ARGUMENT`, and map out-of-range recurrence values to the same code.
   This single change removes the availability lockout and three low findings.
2. **Enforce limits after recurrence expansion (F2).** Check
   `todos.length > TODOTXT_MCP_MAX_TODOS` after appending a recurrence, and fail
   atomically with `LIMIT_EXCEEDED`.
3. **Harden WebDAV reads (F3, F9).** Set `redirect:"manual"` on the `load()` GET
   and treat 3xx as an error; apply HTML/XML detection even when the media type
   is `text/plain`.
4. **Stop echoing payloads (F4).** Report only the expected `<hash> <text>` shape
   and an offset, or truncate to a small preview.
5. **Reject whitespace-only todos (F6).** Require `text.trim().length > 0`.
6. **Document the actual boundary behavior (F10–F13, F17).** Correct the Origin,
   timeout, auth-off, `/healthz` Host, and missing-Content-Type wording; state
   that `/metrics` is unthrottled. Consider throttling `/metrics` or setting
   `connectionsCheckingInterval` if 10/15 s cutoffs are expected.
7. **Add regression tests** for: invalid-month/day lines (load, list, add,
   update, delete), recurrence at the todo cap, WebDAV 302 on load, HTML labeled
   `text/plain`, malformed-update error length, whitespace-only add, and
   two-date edits.
8. **Optional durability work (F14):** `fsync` the temp file and directory if
   acknowledged writes must survive power loss; clean stale `.uuid.tmp` files.

---

## 4. Artifacts

| Path | Contents |
|------|----------|
| `/tmp/theo-audit/http-claims/report.md` | Full C1–C8 evidence, probe scripts, raw JSON/logs, timeout measurements |
| `/tmp/theo-audit/data-claims/report.md` | Full D1–D7 evidence, atomicity/SIGKILL/concurrency/WebDAV probes |
| `/tmp/theo-audit/fuzz-http/report.md` | HTTP/MCP fuzz harness, 3 seeds, per-seed summaries, logs; empty `repros/` (no findings) |
| `/tmp/theo-audit/fuzz-domain/report.md` | Domain fuzz harness, corpus, 457-call log, minimized repros |
| `/tmp/theo-audit/fuzz-domain/repros/` | Runnable repros for F1–F9 and bidi/schema cases |

No repository file was modified by the audit; `git status` was clean before this
report was written.
