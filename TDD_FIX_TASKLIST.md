# TDD Fix Task List — Security Audit 2026-11-08

Source: [`SECURITY_AUDIT_2026-11-08.md`](./SECURITY_AUDIT_2026-11-08.md)
Rule: **red test first, then fix, then green.** Every code fix must have a
regression test that fails on the current tree before the fix.

No commits. Work directly in this worktree. Keep each workstream within its
assigned files so parallel agents do not conflict.

---

## W1 — Domain: dates, limits, validation (Owner: subagent A)

Files: `logic/todo.ts`, `logic/recurrence.ts`, `logic/tools.ts`,
`test/security-fixes-domain.test.ts` (new).

- [x] **T1 — F1 invalid-date lockout.** A pre-existing line with a regex-valid
  but impossible date (`2024-13-01 task`) must remain listable, hashable,
  updatable, and deletable. `toString()` must never throw for a loaded line.
  Add tests for `list_todos`, `add_todos`, `update_todos`, and `delete_todos`
  against a file containing `2024-13-01 task`; all must succeed and preserve
  the raw line.
- [x] **T2 — F5 invalid dates on write.** `add_todos`/`update_todos` with
  `2024-13-01`, `2024-00-00`, `2024-02-30`, `2024-01-39` must return
  `INVALID_ARGUMENT` (not `BACKEND_ERROR`) and save nothing. No silent
  normalization of Feb 30.
- [x] **T3 — F2 MAX_TODOS recurrence bypass.** With
  `TODOTXT_MCP_MAX_TODOS=5` and 5 lines, completing a `rec:+1w` todo must
  return `LIMIT_EXCEEDED` and persist 5 lines. Check the cap after recurrence
  expansion, atomically.
- [x] **T4 — F4 update error echo.** A malformed 2,000-char update must produce
  a bounded error that does not contain the full input payload.
- [x] **T5 — F6 whitespace-only todo.** `add_todos(["   "])` and tab-only text
  must be rejected with `INVALID_ARGUMENT`; no invisible row.
- [x] **T6 — F7 two-date edit.** Editing `2024-01-01 2024-02-02 task` must not
  silently drop a date. Either preserve both tokens or reject with a clear
  `INVALID_ARGUMENT`; test the chosen behavior.
- [x] **T7 — F8 recurrence edges.** Month-end arithmetic must be defined and
  tested (`2026-01-31 +1m`, `2024-02-29 +1y`); out-of-range `rec:` values must
  return `INVALID_ARGUMENT`, never a `BACKEND_ERROR` RangeError. Update existing
  tests only if they assert the old overflow behavior.
- [x] **T8 — Regression.** Run targeted tests
  (`npx vitest run test/security-fixes-domain.test.ts test/todo.test.ts test/todo-recurrence.test.ts test/fuzz-hardening.test.ts test/input-invariants.test.ts test/resource-limits.test.ts`)
  and record red/green output under `/tmp/theo-audit/fixes/w1/`.

## W2 — WebDAV read hardening (Owner: subagent B)

Files: `logic/backends/webdav-backend.ts`, `test/security-fixes-webdav.test.ts`
(new).

- [x] **T9 — F3 redirect on load.** `load()` must use `redirect:"manual"` and
  treat a 3xx as an error instead of parsing the redirect target. Test with a
  mocked `fetch` (and, if easy, a loopback 302).
- [x] **T10 — F9 mislabeled error page.** A full HTML/XML document returned with
  `Content-Type: text/plain` must be rejected. Keep the existing legitimate
  single-line `<html> is a tag` case accepted (do not regress
  `test/fuzz-hardening.test.ts`).
- [x] **T11 — Regression.** Run
  `npx vitest run test/security-fixes-webdav.test.ts test/fuzz-hardening.test.ts test/webdav-resilience.test.ts test/webdav-conditional-writes.test.ts`
  and record red/green output under `/tmp/theo-audit/fixes/w2/`.

## W3 — Docs and operational accuracy (Owner: subagent C)

Files: `SECURITY.md`, `README.md`, `.env.example` (docs only unless a code
change is strictly necessary).

- [x] **T12 — F11 Origin scope.** State that Origin is enforced on `POST /mcp`
  by the MCP transport; other methods/paths rely on CORS header omission, and
  no `ACAO: *` is ever emitted.
- [x] **T13 — F10 `/metrics` abuse coverage.** State explicitly that `/metrics`
  bypasses the `/mcp` rate limiter/lockout/breaker and is therefore an
  unthrottled token oracle; require proxy-level protection or loopback.
- [x] **T14 — F12 timeout granularity.** Clarify that Node's
  `connectionsCheckingInterval` (default 30 s) quantizes the 10 s/15 s deadlines,
  so slow-header/body cutoffs are observed at ~30 s unless the interval is
  lowered at the proxy/process.
- [x] **T15 — F13/F17 accuracy.** Document that only `1/true/yes` enable
  read-only (unknown values fail open); document `createApp()` auth-off as
  test/embedder-only; document missing `Content-Type` acceptance and `/healthz`
  Host validation; fix the contradictory "when authentication is disabled"
  wording.
- [x] **T16 — F14 durability.** Distinguish atomic writes from power-loss
  durability (no fsync) and note stale temp files after a killed writer.
- [x] **T17 — Consistency pass.** Update resource-limit/error-handling text if
  W1 changes behavior; keep `.env.example` comments aligned.

## W4 — Verification (Owner: verifier subagent, after W1–W3)

- [x] **T18** Run `npm run typecheck && npm test`; all tests green.
- [x] **T19** Review `git diff` for scope creep, debug artifacts, and accidental
  edits outside the assigned files.
- [x] **T20** Re-run minimized repros for F1–F7, F9 and confirm the fixed
  behavior.
- [x] **T21** Confirm each fix has a test that failed before it; check
  `/tmp/theo-audit/fixes/*/red.txt`.
- [x] **T22** Write `/tmp/theo-audit/fixes/verification.md` with per-task
  PASS/FAIL, commands, and any follow-ups.

## Acceptance

- [x] Typecheck + full suite green.
- [x] F1, F2, F4, F5, F6, F7, F8, F9 fixed with regression tests.
- [x] F3 fixed (WebDAV load redirect).
- [x] F10–F17 documented accurately or explicitly accepted as residual risk.
- [x] No source behavior changes outside the listed scope.

## Review outcome

- Independent solid/lean review: `/tmp/theo-audit/review/solid-lean.md` —
  **SHIP WITH NITS**. All nine code findings fixed with red-first regressions;
  pre-fix tree reproduced 33 failures / 3 positive controls.
- Auth/internet review: `/tmp/theo-audit/review/auth-internet.md` —
  **not “gold” for internet-facing**. Adequate only for one user behind a TLS
  proxy with a 256-bit token and correct `TRUST_PROXY`; not for teams,
  multi-replica, or public multi-tenant. Tier verdict added to `SECURITY.md`.
- Review nits fixed after the review: recurrence-threshold range (R1),
  minimal mislabeled HTML documents (R2), invalid-date token list (R3),
  two-date display/hash preservation (R8), README claims (R4–R7, R9), local-file
  round-trip test (R10), stale comment (R11).
- Final verification: `npm run typecheck` clean; **36 files / 407 tests passed**.
- Residual accepted risks: F15 (schema `-32602` has no structured code; now
  documented), F16 (bidi display spoofing; now documented), and the auth-model
  gaps listed in `SECURITY.md`.
