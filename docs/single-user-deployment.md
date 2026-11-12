# Single-user deployment runbook (TLS proxy)

This runbook is for **one user, one app instance, one shared `todo.txt`** behind
a TLS-terminating reverse proxy. It is the operational companion to
[`SECURITY.md`](../SECURITY.md) and
[`SINGLE_USER_TLS_TASKLIST.md`](../SINGLE_USER_TLS_TASKLIST.md).

> **What this is not.** The static bearer token is an **API key**, not OAuth 2.1
> and not the MCP authorization profile. There is no discovery
> (`.well-known/oauth-protected-resource`), no per-client identity, no scopes,
> no expiry, and no revocation list. If your MCP client requires OAuth discovery
> instead of a manually configured `Authorization` header, this deployment model
> does not fit that client.

## 1. Decide the shape

| Question | This runbook assumes |
| --- | --- |
| Proxy and app on the same host? | Yes. Otherwise use the proxy's exact IP/CIDR for `TRUST_PROXY` and firewall the app port. |
| Public hostname? | `todo.example.com`; replace everywhere. |
| Token source? | `MCP_AUTH_TOKEN_FILE` (0600 file or Docker secret). Not a Compose `environment:` value. |
| `/metrics` public? | No. Disabled at the app and denied at the proxy. |
| Replicas? | Exactly one. The file lock and abuse state are process-local. |
| Backups? | Host directory outside the container, with a documented retention count. |

## 2. Generate the token and secret file

Use a CSPRNG. `openssl rand -hex 32` produces 64 hex characters (256 bits).

```bash
install -d -m 700 secrets
openssl rand -hex 32 > secrets/mcp_auth_token.txt
chmod 600 secrets/mcp_auth_token.txt
test -s secrets/mcp_auth_token.txt && echo "token file OK"
```

- Never commit `secrets/mcp_auth_token.txt`. `secrets/.gitignore` ignores it.
- Acceptable internet-facing tokens are 64+ hex characters or 43+ base64url
  characters. Do not use a passphrase, and do not put commas or spaces inside a
  token.
- `MCP_ALLOW_WEAK_TOKEN=1` is a local-experiment escape hatch. The server only
  accepts it while `HOST` is loopback and refuses to start with it on a
  non-loopback bind.
- Docker Compose mounts a Compose secret as a read-only file inside the
  container (typically mode `0444`). The host-side `0600` mode and the
  `secrets/` directory permissions are the real access control. A one-time
  group/other-readable warning from the app is expected for a Compose secret; do
  not loosen the host mode because of it. Do not mount the secrets directory
  into the container.

## 3. Configure and start

```bash
cp .env.example .env
# Edit .env:
#   MCP_ALLOWED_HOSTS=todo.example.com
#   MCP_ALLOWED_ORIGINS=https://todo.example.com   # only if a browser client
#   MCP_AUTH_TOKEN=                                # leave empty in .env
#   TRUST_PROXY=loopback                           # or the Docker gateway/CIDR (§5)

docker compose -f docker-compose.deploy.yml up -d
docker compose -f docker-compose.deploy.yml ps
curl -fsS http://127.0.0.1:3000/healthz
```

The deploy Compose file sets:

```yaml
secrets:
  - mcp_auth_token
environment:
  - MCP_AUTH_TOKEN_FILE=/run/secrets/mcp_auth_token
  - HOST=0.0.0.0
  - MCP_METRICS_ENABLED=0
```

`HOST=0.0.0.0` is only for the private container/proxy hop. The published port
stays `127.0.0.1:3000`; never change it to `0.0.0.0:3000` or `3000:3000`.

## 4. Put TLS in front

Use [`deploy/Caddyfile`](../deploy/Caddyfile) or
[`deploy/nginx.conf`](../deploy/nginx.conf). Both:

- redirect HTTP to HTTPS and send HSTS;
- cap request bodies at 64 KiB and enforce header/read timeouts;
- rate limit at the edge;
- forward `Host` and a replaced `X-Forwarded-For`;
- return `404` for `/metrics` by default;
- proxy to `127.0.0.1:3000`.

After reloading the proxy, verify:

```bash
curl -I http://todo.example.com/mcp                 # 301/308 to https
curl -I https://todo.example.com/mcp                # HSTS present
curl -o /dev/null -w '%{http_code}\n' \
  https://todo.example.com/mcp                      # 401 without a token
curl -o /dev/null -w '%{http_code}\n' \
  https://todo.example.com/metrics                  # 404 by default
```

## 5. `TRUST_PROXY` and the real client IP

The safe default is **off**. Enable it only for the actual proxy:

```bash
# Native app + same-host proxy:
TRUST_PROXY=loopback

# Cross-host or Docker bridge:
TRUST_PROXY=172.17.0.1
# or the exact proxy network, e.g. 10.0.0.0/24
```

Confirm that the app sees the client, not the proxy:

```bash
docker compose -f docker-compose.deploy.yml logs -f todo-txt-mcp |
  grep '"msg":"request"'
```

Each request line has an `ip` field. If every request shows `127.0.0.1` or the
Docker gateway, `TRUST_PROXY` is not matching the real peer: all clients share
one rate-limit and lockout bucket. Never use `TRUST_PROXY=true` or
`TRUST_PROXY=0.0.0.0/0` on a reachable host; clients can spoof
`X-Forwarded-For` and defeat the limits.

## 6. Configure the client

Configure the `Authorization` header explicitly. Do not rely on OAuth discovery.
A generic HTTP MCP client entry looks like:

```json
{
  "mcpServers": {
    "todo.txt": {
      "type": "http",
      "url": "https://todo.example.com/mcp",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}
```

Use your client's secret interpolation or OS keychain if it supports one; do not
commit a real token into a dotfile repository. Clients that only support OAuth
discovery cannot use this tier.

**Never put the token in a URL** (`?token=…`, `/mcp/<token>`). URLs are recorded
by browser history, proxy access logs, shell history, and monitoring; the server
does not accept query-string credentials anyway. Only the
`Authorization: Bearer` header is read.

## 7. Rotate the token without downtime

Overlap → reload → verify → remove.

```bash
# 1. Add the new token next to the old one (one per line).
printf '%s\n%s\n' "$(cat secrets/mcp_auth_token.txt)" "$(openssl rand -hex 32)" \
  > secrets/mcp_auth_token.txt.new
chmod 600 secrets/mcp_auth_token.txt.new
mv secrets/mcp_auth_token.txt.new secrets/mcp_auth_token.txt

# 2. Reload the file in the running process.
docker kill --signal=HUP \
  "$(docker compose -f docker-compose.deploy.yml ps -q todo-txt-mcp)"

# 3. Update every client to the new token, then verify the new one works and
#    the old one is no longer needed.

# 4. Leave only the new token in the file and reload again.
printf '%s\n' '<new-token>' > secrets/mcp_auth_token.txt
chmod 600 secrets/mcp_auth_token.txt
docker kill --signal=HUP \
  "$(docker compose -f docker-compose.deploy.yml ps -q todo-txt-mcp)"
```

`SIGHUP` re-reads `MCP_AUTH_TOKEN_FILE` atomically. If the file is missing,
empty, unreadable, or contains no valid token, the **old tokens stay active** and
a warning is logged. `SIGHUP` has no effect when the active source is
`MCP_AUTH_TOKEN`/`MCP_AUTH_TOKENS`; restart the process for those. If signal
delivery is unavailable (for example on Windows), restart and confirm the old
token returns `401`.

## 8. Revoke a leaked token

1. Remove the leaked token from `secrets/mcp_auth_token.txt` (keep the others),
   then send `SIGHUP`.
2. Verify revocation: a request with the old token must return `401`.
3. If `SIGHUP` is unavailable or the reload warning says the file was rejected,
   restart the service and verify again.
4. Treat the leak as an incident (§10): inspect logs, rotate the remaining
   tokens, and check the todo file for unauthorized changes.

## 9. Back up and restore

See [`backup-restore.md`](backup-restore.md) for the full procedure and a
copy-paste script. The minimum rules:

- Snapshot `data/todo.txt` before every upgrade or token rotation.
- Keep at least 7–14 timestamped copies outside the container, mode `0600`.
- Verify a backup by size, UTF-8 validity, and a `list_todos` call after a test
  restore.
- Stop the app before restoring; replace the file atomically; keep the previous
  file until the restored one is verified.
- The local backend writes atomically (temp + rename) but does not `fsync`, so a
  power loss can lose the last acknowledged write. A backup is the only rollback.

## 10. Incident steps

1. **Contain:** remove the suspect token, `SIGHUP`, confirm `401`. If the host may
   be compromised, stop the service and the proxy.
2. **Preserve evidence:** copy the container logs and the current `todo.txt`
   before restoring anything. Do not rotate logs away.
3. **Inspect:** look for `401`/`429` bursts, `auth_failure_circuit_breaker`,
   `request` lines with unexpected `ip` values, and any writes you did not make.
4. **Restore:** if the file was modified or corrupted, restore the newest
   verified backup while the app is stopped (§9).
5. **Recover:** generate new tokens, update clients, restart, verify with
   `list_todos`, then re-enable the proxy.
6. **Review:** check proxy logs, secret file modes, `.env` contents, and whether
   the token appeared in a URL, shell history, or client config.

## 11. Logs, retention, and redaction

- The app writes structured JSON. Tokens, `Authorization` headers, request
  bodies, and todo content are never logged. `MCP_LOG_LEVEL=info` is the
  production default; `debug` increases volume and should be temporary.
- Both Compose files use Docker's `json-file` driver with `max-size: 10m` and
  `max-file: 3` (30 MB per container). Adjust for your disk budget.
- The proxy has its own logs. Rotate them with `logrotate` (or Caddy's log
  rolling options). Keep proxy access logs at least as long as your incident
  window, but do not log request bodies or `Authorization` headers.
- If you ship logs to a central system, redact `Authorization`, `Cookie`, and
  query strings. A token in a URL is a token in every access log.
- Alert on `401`/`429` spikes, breaker lines, readiness/health failures, and
  disk usage. The counter series are per process and reset on restart.

## 12. Upgrade checklist

- [ ] Back up `data/todo.txt` and record its checksum.
- [ ] Read the release notes and `SECURITY.md` changes.
- [ ] `docker compose -f docker-compose.deploy.yml build --pull`
- [ ] `docker compose -f docker-compose.deploy.yml up -d`
- [ ] `/healthz` is `200` on the public host. `/readyz` is `200` over
      loopback or an internal listener (for example
      `curl -fsS http://127.0.0.1:3000/readyz`) and `404` through the
      reference proxy: it is an internal/orchestrator probe, not a public
      endpoint, because it loads and serializes the todo list. Do not put the
      MCP bearer token in a probe spec. An authenticated `list_todos` succeeds
      and lists the expected todos.
- [ ] `/metrics` is still `404` unless deliberately enabled.
- [ ] Confirm the client IP in logs is still the real client.
- [ ] Keep the previous image and backup until the new one has run normally.
