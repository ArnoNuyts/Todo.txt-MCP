# Security

`todo.txt-mcp` is designed to be a **local-first** service: it exposes an MCP
endpoint that reads and writes a single `todo.txt` file. This document
describes the threat model, the defaults that keep the server safe, and how to
expose it deliberately and securely.

## Threat model

The endpoint can read, add, edit, and complete todos. Anyone who can reach
`/mcp` can therefore read and modify the whole todo file. The realistic threats
are:

- **Other machines on the network** calling an unintentionally exposed port.
- **Malicious web pages** in the user's browser reaching `localhost` through
  DNS rebinding or cross-origin requests (CSRF-style access to a local service).
- **Accidental exposure** by publishing a container port on all interfaces or
  by binding the process to `0.0.0.0` without thinking about it.
- **Eavesdropping / tampering** when traffic crosses a network without TLS.

The following are **out of scope**: a compromised host machine, a compromised
`todo.txt`, an attacker who already has local shell access, and multi-tenant
authorization (there is a single shared todo file).

## Secure defaults

- The server binds to `127.0.0.1` unless `HOST` is set.
- The Docker Compose files publish the port on `127.0.0.1:3000` only, run the
  container read-only with `cap_drop: ["ALL"]`, `no-new-privileges`, and a
  writable `/tmp` tmpfs. The todo file lives on a writable bind-mounted
  directory (`./data:/data`) so atomic replace-by-rename works while the rest
  of the filesystem stays read-only.
- **Host header validation** (DNS rebinding protection). Only these hostnames
  are accepted by default: `localhost`, `127.0.0.1`, `[::1]`. Ports are
  ignored, and a missing or invalid `Host` header is rejected with a `403`
  JSON-RPC error.
- **Origin allowlist (`POST /mcp` only).** Cross-origin browser requests are
  only allowed from `http://localhost:3000` by default. The MCP transport
  enforces the allowlist on `POST /mcp`. Other methods on `/mcp` (`OPTIONS`,
  `GET`, `DELETE`) and the `/healthz`, `/readyz`, and `/metrics` routes do not
  reject a disallowed `Origin`; they rely on CORS header omission. They never emit
  `Access-Control-Allow-Origin: *` and never reflect a disallowed origin, so a
  browser cannot read their responses. Requests without an `Origin` header
  (command-line clients, MCP clients) continue to work. If `MCP_ALLOWED_ORIGINS`
  is empty, no CORS headers are emitted and `POST /mcp` requests that carry an
  `Origin` header are rejected with a `403`.
- **Request body limit.** Request bodies are capped at 64 KiB. `POST /mcp`
  accepts `application/json` and `application/*+json`; any other declared media
  type is rejected with `415`. A request with **no** `Content-Type` header is
  treated as `application/json`, so command-line clients that omit it still
  work.
- The server is stateless (`sessionIdGenerator: undefined`) and returns JSON
  responses rather than long-lived SSE streams.
- `/mcp`, `/metrics`, and `/readyz` send `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `Cache-Control: no-store`,
  `Cross-Origin-Resource-Policy: same-origin`, and
  `Content-Security-Policy: default-src 'none'`; the framework name is not
  advertised. Structured logs never include tokens, bodies, or todo content.
- `GET /healthz` returns `{"status":"ok"}` for liveness checks and is never
  authenticated, but it is still subject to Host validation: a missing or
  foreign `Host` header is rejected with `403`. `GET /readyz` is
  **unauthenticated** and Host-validated; it performs a bounded load/serialize
  of the todo list and returns `503 {"status":"unavailable"}` when the backend
  is broken. Because it triggers backend work, `/readyz` is for internal
  orchestrator probes only: probe it over loopback or an internal listener, and
  keep `/healthz` for public liveness checks. The reference Caddy and nginx
  configs return `404` for `/readyz`, `/readyz/`, and case variants on the
  public host. A successful readiness result is cached for 5 seconds to absorb
  probe floods; failures are never cached. `/readyz` also has its own
  per-client limiter (`MCP_READYZ_RATE_LIMIT_PER_MIN`, default 120; `0`
  disables) and returns a JSON-RPC `429` with `Retry-After` when a probe budget
  is exhausted; `/healthz` is never rate limited. Never put the MCP bearer
  token in a probe spec. `/mcp` and `/metrics` require a bearer token; the
  server refuses to start when no token source is configured.
- **`/metrics` is off by default on a network deployment.** It is enabled when
  the server binds loopback and disabled when `HOST` is non-loopback, unless
  `MCP_METRICS_ENABLED` explicitly enables it. Set `MCP_METRICS_TOKEN` to keep
  the metrics credential separate from the `/mcp` token. The proxy examples deny
  `/metrics` as well.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Interface to bind to. Use `0.0.0.0` only inside a container or behind a proxy. |
| `PORT` | `3000` | Listen port (integer 0-65535). |
| `MCP_ALLOWED_HOSTS` | `localhost,127.0.0.1,[::1]` | Comma-separated hostnames accepted in the `Host` header. Hostnames only, no ports. |
| `MCP_ALLOWED_ORIGINS` | `http://localhost:3000` | Comma-separated origins allowed for browser clients. Empty disables CORS entirely. |
| `MCP_AUTH_TOKEN` | unset | Single bearer token. `/mcp` and `/metrics` require `Authorization: Bearer <token>`. At least one token source (`MCP_AUTH_TOKEN`, `MCP_AUTH_TOKENS`, or `MCP_AUTH_TOKEN_FILE`) is required. |
| `MCP_AUTH_TOKENS` | unset | Comma/whitespace separated list of active tokens for rotation. Takes precedence over `MCP_AUTH_TOKEN`. |
| `MCP_AUTH_TOKEN_FILE` | unset | File containing one or more tokens. Takes precedence over both environment variables. Keep it mode `0600`. Reloaded on `SIGHUP`; an unreadable/empty file keeps the previous tokens. |
| `MCP_ALLOW_WEAK_TOKEN` | unset | Set to `1` to allow env/file tokens shorter than 32 characters. Loopback-only: the server refuses to start with this override on a non-loopback `HOST`, and warns loudly when it is accepted. |
| `MCP_LOG_LEVEL` | `info` | Structured JSON log level: `debug`, `info`, `warn`, or `error`. |
| `MCP_METRICS_ENABLED` | loopback: on; non-loopback: off | Set to `1`/`true`/`yes` to enable `GET /metrics` on a non-loopback bind, or `0`/`false`/`no` to disable it anywhere. Disabled means `404`. |
| `MCP_METRICS_TOKEN` | unset | Optional separate high-entropy token for `/metrics`. When set, only this token is accepted there; the `/mcp` token is rejected. |
| `MCP_METRICS_RATE_LIMIT_PER_MIN` | `60` | Separate per-client rate limit for `/metrics`. `0` disables the metrics limiter; this limiter never triggers the `/mcp` auth ban. |
| `MCP_READ_ONLY` | unset | Set to `1`, `true`, or `yes` (case-insensitive) to register only `list_todos`; mutating tools are absent. `0`, `false`, `no`, or empty leaves writes enabled. Any other value fails startup. |
| `MCP_READYZ_RATE_LIMIT_PER_MIN` | `120` | Separate per-client rate limit for unauthenticated `GET /readyz`. `0` disables the limiter; `/healthz` is never limited. |
| `TRUST_PROXY` | `false` | Express `trust proxy` setting. Accepts `false`, `true`, a hop count, `loopback`, or an IP/CIDR list. Leave unset/false unless a trusted proxy is in front. `true` or a `/0` wildcard is refused when `HOST` is non-loopback. |
| `MCP_RATE_LIMIT_PER_MIN` | `60` | Requests per client key per minute. `0` disables the rate limiter. |
| `MCP_AUTH_FAIL_LIMIT` | `10` | Failed authentications before a client key is temporarily banned. |
| `MCP_AUTH_FAIL_WINDOW_SEC` | `900` | Sliding window for counting authentication failures. |
| `MCP_AUTH_BAN_SEC` | `900` | Base ban duration. Repeat offenders escalate up to one hour. |
| `MCP_MAX_CONCURRENCY` | `20` | In-flight `POST /mcp` requests before new work is rejected with `503`. `0` disables the guard. |
| `MCP_GLOBAL_AUTH_FAIL_LIMIT` | `100` | Failed authentications per window across all keys before the global breaker sheds `/mcp` traffic. |
| `MCP_GLOBAL_AUTH_FAIL_WINDOW_SEC` | `60` | Sliding window for the global authentication-failure breaker. |
| `MCP_GLOBAL_AUTH_FAIL_BAN_SEC` | `60` | How long the global breaker stays open. |
| `MCP_MAX_TRACKED_KEYS` | `10000` | Maximum keys retained by the in-process limiters. |

When `MCP_ALLOWED_HOSTS` is set explicitly, include every name clients use. For
example, to reach the server through a TLS proxy at `https://todo.example.com`,
set `MCP_ALLOWED_HOSTS=todo.example.com` (and keep `localhost,127.0.0.1` if you
still connect locally), and add `https://todo.example.com` to
`MCP_ALLOWED_ORIGINS` if a browser client is used.

## stdio mode

`--stdio` (or `MCP_TRANSPORT=stdio`) runs the server as a child process of the
MCP client. It does not open a port, so Host/Origin validation, bearer tokens,
TLS, rate limits, and metrics do not apply: the client's OS user and the process
boundary are the security boundary. stdout is reserved for protocol frames and
all logs go to stderr.

## Authentication (required)

Authentication is **mandatory**. The server refuses to start when none of
`MCP_AUTH_TOKEN`, `MCP_AUTH_TOKENS`, or `MCP_AUTH_TOKEN_FILE` is set, or when
every configured value is empty.

The exported `createApp()` factory can build an app without tokens for tests and
embedders. That auth-off mode is not reachable from `main()`, which always
resolves a token source and exits when none is configured.

Set a long, random token and pass it to clients as a bearer token:

```bash
# Generate a token
openssl rand -hex 32

# Run locally
MCP_AUTH_TOKEN="$(openssl rand -hex 32)" npm start
```

Or via Docker Compose. The quick-start file passes
`MCP_AUTH_TOKEN` in the environment, which is convenient locally but visible to
`docker inspect`. For a public host use the deploy file, which reads a Docker
secret through `MCP_AUTH_TOKEN_FILE`:

```bash
install -d -m 700 secrets
openssl rand -hex 32 > secrets/mcp_auth_token.txt
chmod 600 secrets/mcp_auth_token.txt
docker compose -f docker-compose.deploy.yml up -d
```

See [`deploy/README.md`](./deploy/README.md) and
[`docs/single-user-deployment.md`](./docs/single-user-deployment.md).

Clients then send:

```
Authorization: Bearer <token>
```

Missing or incorrect credentials receive `401 Unauthorized` with a JSON-RPC
error body. Both sides are hashed with SHA-256 and compared with
`timingSafeEqual` over the fixed-size digests, so the expected length is not
exposed through timing.

Note that bearer tokens are only as private as the transport. Do not send the
token over plain HTTP across a network you do not trust, and do not commit it
to the repository. `.env` files are ignored by git; `.env.example` documents
the variables without real secrets.

The 32-character minimum is a floor, not an entropy guarantee. For an
internet-facing deployment use a CSPRNG-generated 256-bit secret: 64 hex
characters from `openssl rand -hex 32`, or at least 43 base64url characters.
Do not use a passphrase, a repeated pattern, or anything that contains commas or
whitespace. The server rejects values shorter than 32 characters and obviously
weak patterns (a single repeated character, too few distinct characters, or a
common word), and warns when a non-hex token is shorter than the recommended
64-hex/43-base64url shape. A 32-character value can pass the floor; it is not
the target for a public host.

`MCP_ALLOW_WEAK_TOKEN=1` is a local-experiment escape hatch. It is **loopback
only**: the server refuses to start with the override when `HOST` is
non-loopback, and emits a loud startup warning when it is accepted on loopback.
Never use it on a public host.

### Authentication model and deployment tiers

This is a **shared static bearer token**, not an identity system. It is an
API-key-grade gate: not OAuth 2.1 and not the MCP authorization profile. There
is no per-client identity, scopes, expiry, revocation list, or attribution.
Every holder of the token can read and modify the whole todo file, and every
client behind one token is indistinguishable in the logs.

Concretely, the server does **not** provide OAuth discovery: there is no
`.well-known/oauth-protected-resource` document, no authorization-server
metadata, no client registration, and no `resource_metadata` challenge. A client
must support a manually configured `Authorization: Bearer <token>` header. If
your client requires OAuth discovery, this deployment tier does not fit it; use
an identity-aware proxy or a different client.

Use these tiers to decide whether the model fits:

| Deployment | Verdict |
| --- | --- |
| Loopback only, as shipped | Adequate for a local single user |
| One user behind a TLS proxy | Adequate **only if** the token is 256-bit, `TRUST_PROXY` matches the real proxy, `/metrics` is disabled or separately protected, and one replica owns the file |
| Small trusted team (shared file) | **Not adequate**: no per-client identity, scopes, revocation, or audit |
| Public multi-tenant / SaaS | **Not adequate**: no tenant isolation, OAuth 2.1, or MCP resource metadata |
| Multi-replica deployment | **Not adequate**: abuse state is per process and the file lock is process-local |

For the exact hardening steps required before public exposure, see
[`SINGLE_USER_TLS_TASKLIST.md`](./SINGLE_USER_TLS_TASKLIST.md).

Known limits of this model, even for the single-user tier:

- A leaked token remains valid until the operator removes it from the token
  source and reloads (`SIGHUP`) or restarts. There is no expiry or revocation
  list; revocation is deletion plus reload.
- The global auth-failure breaker is designed to shed invalid traffic without
  blocking a client that holds a valid token (TLS-4). Builds that check the
  breaker before authentication can briefly return `503` to a valid token
  during a distributed burst.
- `/metrics` is disabled by default on a non-loopback bind, but if you enable it
  it still shares the listener and process. Use a separate
  `MCP_METRICS_TOKEN`, keep the proxy deny rule, and scrape from a trusted
  network.
- `MCP_READ_ONLY` is process-wide. It cannot give one client read-only access
  while another client writes.
- Several active tokens in `MCP_AUTH_TOKENS` or the token file are fine for
  rotation, but they still share one identity and one full-access scope.
- One replica only. Abuse state is per process and the file lock is
  process-local.

Never put the token in a URL (`?token=…`, `/mcp/<token>`). Proxy access logs,
browser history, shell history, and monitoring record URLs; the server only
reads the `Authorization` header.

If you need team or public exposure, put an identity-aware proxy (OIDC/mTLS)
in front, or plan the move to per-client tokens with scopes and an audit trail;
the long-term MCP profile is OAuth 2.1 with RFC 9728 resource metadata.

### Token rotation

Several tokens can be active at once. A request is authorized when it matches
**any** configured token, so rotation does not require a flag day. Precedence is
`MCP_AUTH_TOKEN_FILE` > `MCP_AUTH_TOKENS` > `MCP_AUTH_TOKEN`; a token file wins
so a stale environment list cannot keep an old secret valid.

For a file-based deployment, rotate without restarting:

```bash
# 1. Add the new token next to the old one (one per line).
printf '%s\n%s\n' "$(cat secrets/mcp_auth_token.txt)" "$(openssl rand -hex 32)" \
  > secrets/mcp_auth_token.txt.new
chmod 600 secrets/mcp_auth_token.txt.new
mv secrets/mcp_auth_token.txt.new secrets/mcp_auth_token.txt

# 2. Reload the file (Docker example; use `kill -HUP <pid>` for a native app).
docker kill --signal=HUP \
  "$(docker compose -f docker-compose.deploy.yml ps -q todo-txt-mcp)"

# 3. Update all clients, verify the new token, then leave only the new token
#    in the file and send SIGHUP again.
```

`SIGHUP` re-reads `MCP_AUTH_TOKEN_FILE` atomically. If the file is missing,
empty, unreadable, or contains no valid token, the **previous tokens stay
active** and a warning is logged. Reload has no effect when the active source is
`MCP_AUTH_TOKENS`/`MCP_AUTH_TOKEN`; restart for those. Where signals are
unavailable (for example on Windows), restart and verify that the removed token
returns `401`.

The same procedure is the revocation path: delete the compromised token, send
`SIGHUP`, and confirm `401` for the old value. See the runbook in
[`docs/single-user-deployment.md`](./docs/single-user-deployment.md).

### File-based secrets

For containers and secret managers, point the server at a file instead of
passing the secret in the environment:

```bash
install -d -m 700 secrets
openssl rand -hex 32 > secrets/mcp_auth_token.txt
chmod 600 secrets/mcp_auth_token.txt
MCP_AUTH_TOKEN_FILE="$PWD/secrets/mcp_auth_token.txt" npm start
```

The file may contain one token per line or a comma/whitespace separated list.
The server warns once at startup if the file is readable by group or other on
POSIX, and refuses to start if the file is missing, empty, or unreadable.
Environment/file tokens shorter than 32 characters, and obvious weak patterns,
are rejected. A 32–42 character non-hex token is accepted with a warning but is
below the recommended 256-bit shape; prefer `openssl rand -hex 32`. The
loopback-only `MCP_ALLOW_WEAK_TOKEN=1` escape hatch skips the checks. Explicit
programmatic options (used by the test suite) are exempt.

Docker Compose mounts a `secrets:` file read-only inside the container
(typically mode `0444`), so the host-side `0600` mode and directory permissions
are the real control. Keep the host file at `0600` and never mount the whole
secrets directory. The app may log a one-time warning that the mounted file is
group/other-readable; that is a Compose mount limitation, not a reason to loosen
the host mode.

## Read-only mode

Set `MCP_READ_ONLY=1` (also `true` or `yes`, case-insensitive) to register only
`list_todos`. `0`, `false`, `no`, or an empty value leaves the write tools
enabled. Any other value — including `on`, `truee`, or `2` — fails startup with
a clear error instead of silently enabling writes. `add_todos`, `update_todos`,
and `delete_todos` are absent from `tools/list` and cannot be called. The
`todo_format` prompt and all MCP resources remain available. An explicit
`{ readOnly: false }` programmatic option overrides the environment variable.

## Structured logging and metrics

The server writes one JSON object per line. `debug`/`info` go to stdout and
`warn`/`error` to stderr; `MCP_LOG_LEVEL` selects the minimum level (default
`info`). Every request gets a request ID from a validated `X-Request-ID` header
(`[A-Za-z0-9._-]{1,128}`) or a UUID, is echoed in the response header, and
produces one `msg: "request"` line with method, path, status, duration,
client IP, and authentication result.

Logs intentionally contain **no** `Authorization` header, token value, request
body, or todo content. Authentication failures and rate-limit/lockout `429`
responses are logged at `warn` with the request ID and client IP so operators
can alert on bursts without collecting user data.

`GET /metrics` exposes dependency-free in-process Prometheus counters:

```text
todo_mcp_requests_total
todo_mcp_responses_2xx_total
todo_mcp_responses_4xx_total
todo_mcp_responses_5xx_total
todo_mcp_responses_401_total
todo_mcp_responses_429_total
todo_mcp_auth_failures_total
```

Counters are per process and reset on restart. `/metrics` is enabled when the
server binds loopback and **disabled (404) when `HOST` is non-loopback**, unless
`MCP_METRICS_ENABLED` explicitly enables it. The deploy Compose file sets
`MCP_METRICS_ENABLED=0`, and the proxy examples return `404` for `/metrics`.

By default `/metrics` accepts the same bearer token as `/mcp`. If you set a
separate high-entropy `MCP_METRICS_TOKEN`, only that token is accepted there and
the `/mcp` token is rejected. Metrics have their own per-client limiter
(`MCP_METRICS_RATE_LIMIT_PER_MIN`, default 60; `0` disables it) and never
trigger the `/mcp` authentication ban or global breaker; excess scrapes get
`429` with `Retry-After`.

If you enable metrics on a public listener, keep the proxy deny rule unless you
really need remote scraping, use the separate token, and scrape from a trusted
network. Because metrics can reveal traffic patterns, prefer loopback. Both
`/mcp` and `/metrics` send `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`, and `Cache-Control: no-store`.

## TLS via reverse proxy

The server speaks plain HTTP. To expose it beyond the local machine, put a TLS
terminating reverse proxy in front of it and keep the app port on
`127.0.0.1:3000`. The complete, copyable references are
[`deploy/Caddyfile`](./deploy/Caddyfile) and
[`deploy/nginx.conf`](./deploy/nginx.conf); [`deploy/README.md`](./deploy/README.md)
explains the mapping.

Both references:

- terminate TLS and redirect HTTP to HTTPS;
- send HSTS (`Strict-Transport-Security: max-age=31536000; includeSubDomains`);
- cap request bodies at 64 KiB and set header/read timeouts;
- rate limit at the proxy (Caddy `rate_limit` requires the
  [`caddy-ratelimit`](https://github.com/mholt/caddy-ratelimit) plugin; nginx
  uses `limit_req`);
- forward `Host` and replace any client-supplied `X-Forwarded-For`;
- return `404` for `/metrics` unless explicitly enabled;
- proxy to `127.0.0.1:3000`.

The key Caddy directives:

```caddyfile
http://todo.example.com {
    redir https://{host}{uri} permanent
}

todo.example.com {
    header Strict-Transport-Security "max-age=31536000; includeSubDomains"
    request_body { max_size 64KB }   # Caddy 2.10+

    handle /metrics { respond 404 }

    reverse_proxy 127.0.0.1:3000 {
        header_up Host {host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }
}
```

The key nginx directives:

```nginx
limit_req_zone $binary_remote_addr zone=todo_mcp:10m rate=60r/m;

server {
    listen 443 ssl;
    server_name todo.example.com;

    ssl_certificate     /etc/letsencrypt/live/todo.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/todo.example.com/privkey.pem;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    client_max_body_size 64k;
    client_header_timeout 10s;
    client_body_timeout 15s;

    location = /metrics { return 404; }

    location / {
        limit_req zone=todo_mcp burst=20 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
    }
}
```

Guidance:

- Keep the proxy and the MCP server on the same host / private network; do not
  publish the app port on a public interface.
- Forward the original `Host` header and add the public hostname to
  `MCP_ALLOWED_HOSTS`. Replace, do not append to, client-supplied
  `X-Forwarded-For`.
- Set `TRUST_PROXY=loopback` when the proxy and the Node process share the
  host's loopback interface. If the app runs in Docker with a published
  `127.0.0.1:3000` port, the container usually sees the Docker bridge gateway
  (for example `172.17.0.1`) instead; trust that exact address/CIDR. Without a
  matching setting, every client appears as the proxy and one client's failures
  can lock out all clients. Never use `TRUST_PROXY=true` or a wildcard.
- Terminate TLS at the proxy, keep certificates current, and redirect HTTP to
  HTTPS.
- Combine TLS with the bearer token: TLS protects the token in transit, the
  token protects the endpoint from unauthorized callers.
- If the proxy and server are on different hosts, set `HOST=0.0.0.0` (or the
  private interface) for the server and firewall the port so only the proxy can
  reach it.
- Keep the proxy's access-log retention and redaction separate from the app's
  logs. Never log `Authorization` headers or query strings that might contain a
  token.

## Single-user deployment runbook

This is the short form. The full commands and verification checklist are in
[`docs/single-user-deployment.md`](./docs/single-user-deployment.md), with
backup/restore detail in [`docs/backup-restore.md`](./docs/backup-restore.md).

**Assumptions.** One user, one replica, proxy and app on the same host (or a
private network), `/metrics` not public, and the token in a `0600` file or Docker
secret. If any of those is false, stop and adjust `TRUST_PROXY`, the firewall,
and the proxy rules first.

### 1. Token generation and secret file mode

```bash
install -d -m 700 secrets
openssl rand -hex 32 > secrets/mcp_auth_token.txt   # 64 hex chars = 256 bits
chmod 600 secrets/mcp_auth_token.txt
```

- Use `MCP_AUTH_TOKEN_FILE`; do not pass the production token in a Compose
  `environment:` value.
- Docker Compose mounts the secret read-only (typically mode `0444` inside the
  container); the host `0600` file and `secrets/` directory mode are the real
  control. Never mount the directory into the container.
- The file may hold several tokens, one per line, during rotation.
- `MCP_ALLOW_WEAK_TOKEN` is loopback-only and refused on a non-loopback bind.

### 2. Start and verify

```bash
docker compose -f docker-compose.deploy.yml up -d
curl -fsS http://127.0.0.1:3000/healthz
curl -o /dev/null -w '%{http_code}\n' https://todo.example.com/mcp    # 401
curl -o /dev/null -w '%{http_code}\n' https://todo.example.com/metrics # 404
```

Set `MCP_ALLOWED_HOSTS` to the public hostname and `MCP_ALLOWED_ORIGINS` only if
a browser client is used. Confirm the real client IP in the `msg:"request"`
log line; otherwise `TRUST_PROXY` does not match the proxy.

### 3. Client configuration

The client must send the header explicitly:

```json
{
  "mcpServers": {
    "todo.txt": {
      "type": "http",
      "url": "https://todo.example.com/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

There is no OAuth discovery, so a client that requires it cannot use this tier.
Use your client's secret store or environment interpolation; do not commit the
token. **Never put the token in a URL** (`?token=…`, `/mcp/<token>`): proxies,
browsers, shell history, and monitoring record URLs, and the server reads only
the `Authorization` header.

### 4. Rotation, reload, and revocation

Overlap → `SIGHUP` → verify → remove old → `SIGHUP`:

```bash
printf '%s\n%s\n' "$(cat secrets/mcp_auth_token.txt)" "$(openssl rand -hex 32)" \
  > secrets/mcp_auth_token.txt.new
chmod 600 secrets/mcp_auth_token.txt.new
mv secrets/mcp_auth_token.txt.new secrets/mcp_auth_token.txt
docker kill --signal=HUP \
  "$(docker compose -f docker-compose.deploy.yml ps -q todo-txt-mcp)"
```

`SIGHUP` re-reads the token file atomically. A missing, empty, unreadable, or
invalid file keeps the previous tokens active and logs a warning. Reload has no
effect for `MCP_AUTH_TOKENS`/`MCP_AUTH_TOKEN`; restart for those. Without signal
support, restart and verify.

Revocation is the same edit: remove the leaked token, send `SIGHUP`, and confirm
the old value gets `401`. Then inspect logs and the todo file for unauthorized
changes.

### 5. Backups and restore

- Snapshot `data/todo.txt` before upgrades, rotations, or bulk edits.
- Keep 7–14 timestamped copies outside the container, mode `0600`, plus one
  encrypted off-host copy if the data matters.
- Local writes are atomic but not `fsync`ed, so a crash can lose the last
  acknowledged write. A backup is the rollback.
- Restore while the app is stopped: validate size/UTF-8, replace atomically,
  start, then verify with `list_todos`. Keep the previous file until verified.

See [`docs/backup-restore.md`](./docs/backup-restore.md).

### 6. Incident steps

1. Remove the suspect token, `SIGHUP`, and confirm `401`.
2. Preserve container and proxy logs, and copy the current `todo.txt` before
   restoring anything.
3. Look for `401`/`429` bursts, `auth_failure_circuit_breaker`, unexpected
   client `ip` values, and writes you did not make.
4. Restore the newest verified backup if the file was modified.
5. Generate new tokens, update clients, restart, verify, and review how the
   token leaked (URL, shell history, client config, proxy log).

### 7. Log retention and redaction

- App logs contain no tokens, `Authorization` headers, request bodies, or todo
  content. Keep `MCP_LOG_LEVEL=info` in production; `debug` is temporary.
- Both Compose files use Docker `json-file` with `max-size: 10m` and
  `max-file: 3` (about 30 MB per container).
- Rotate proxy logs with `logrotate` or Caddy's log rolling. Do not log
  `Authorization` or request bodies, and redact query strings if you ship logs
  off-host.
- Alert on `401`/`429` spikes, breaker lines, health/readiness failures, and
  disk usage. Metrics counters are per process and reset on restart.
## Public exposure limits

When `/mcp` is reachable by anything other than the local user, the server
applies in-process abuse controls at the HTTP boundary. They protect the
backend from brute-force token guessing and request floods, but they are not a
substitute for rate limiting and TLS at the proxy.

**Per-client rate limit.** Requests are counted in a sliding one-minute window,
keyed by `req.ip`. IPv6 clients share a `/64` prefix key, IPv4-mapped addresses
are reduced to plain IPv4, and missing addresses fall back to a shared
`unknown` key. Responses carry `RateLimit-Limit`, `RateLimit-Remaining`, and
`RateLimit-Reset` headers. Excess requests receive `429` with `Retry-After`
and a JSON-RPC error body. The store is capped at `MCP_MAX_TRACKED_KEYS`
(default 10,000) with LRU eviction, so rotating source addresses cannot grow
memory without bound. `MCP_RATE_LIMIT_PER_MIN=0` disables this check.

**Authentication lockout.** After `MCP_AUTH_FAIL_LIMIT` failed attempts inside
`MCP_AUTH_FAIL_WINDOW_SEC`, the client key is banned for
`MCP_AUTH_BAN_SEC`. Banned requests receive `429` with `Retry-After` and:

```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32000,
    "message": "Too many failed authentication attempts."
  },
  "id": null
}
```

This response is identical whether the request carries no token, a malformed
token, or the correct token **for as long as the ban is active**. A successful
authentication clears the failure counter. Bans expire automatically. The
configured base duration applies to the first lockout; repeat lockouts double
that base and are never shorter than the 1 minute → 5 minutes → 15 minutes →
1 hour ladder, capped at one hour. Because the token is shared, a permanent ban
would lock out NATed users, so bans are always temporary.

**Global circuit breaker.** More than `MCP_GLOBAL_AUTH_FAIL_LIMIT` failures
across all client keys within `MCP_GLOBAL_AUTH_FAIL_WINDOW_SEC` trips a global
breaker: invalid `/mcp` traffic gets `503` with `Retry-After` and a loud security
log line until `MCP_GLOBAL_AUTH_FAIL_BAN_SEC` elapses. This catches distributed
guessing that per-key limits cannot see. A client presenting a valid token is
not blocked solely because other clients failed (TLS-4); builds that check the
breaker before authentication can still return `503` to a valid token during a
burst.

**Concurrency cap.** At most `MCP_MAX_CONCURRENCY` `POST /mcp` requests may be
in flight. Additional work is rejected immediately with `503` and
`Retry-After: 1` instead of piling up behind the in-process backend lock.

**Connection timeouts.** After `listen()`, the server sets
`requestTimeout = 15s`, `headersTimeout = 10s`, and `keepAliveTimeout = 5s` to
cut off slow-header and slow-body connections. Node enforces the request and
header deadlines on its connections-checking tick, controlled by
`connectionsCheckingInterval` (default 30s). The configured 10s/15s values are
therefore quantized: slow-header and slow-body cutoffs are observed at roughly
30s unless the interval is lowered for the process, or the proxy in front
enforces shorter deadlines.

`GET /healthz` is registered before all abuse controls and is never rate
limited or authenticated, so orchestrators can still probe the process.

### Trust proxy

By default the server never trusts `X-Forwarded-For`; keying on it without a
real proxy would let any client choose its own limiter key. If (and only if) a
trusted reverse proxy is in front, set `TRUST_PROXY` to that proxy or its
network, for example:

```bash
# One proxy hop (Caddy/nginx on the same host)
TRUST_PROXY=loopback

# Explicit proxy network
TRUST_PROXY=10.0.0.0/8,172.16.0.0/12
```

Never enable it on a host that clients can reach directly: spoofed
`X-Forwarded-For` headers would defeat the rate limiter and lockout. The server
refuses to start when `HOST` is non-loopback and `TRUST_PROXY` is `true` or a
`/0` wildcard (`0.0.0.0/0`, `::/0`, or a list containing one).

### Limitations

- Counters are **per process**. Multiple replicas keep independent state, and a
  restart clears all bans and counters. Put coarse rate limits at the proxy too.
- Client identity is IP-based. Users behind a shared NAT share a bucket.
- The controls bound memory and queue growth, not total CPU or bandwidth. The
  proxy should still enforce connection and body limits.
- `MCP_RATE_LIMIT_PER_MIN=0` and `MCP_MAX_CONCURRENCY=0` disable only those
  individual checks; authentication lockout and the global breaker remain.

### Public exposure checklist

- [ ] Bind to loopback and terminate TLS at a trusted proxy.
- [ ] Set a 256-bit token through `MCP_AUTH_TOKEN_FILE` (or the Docker secret
      that feeds it). Startup fails without a token source; never bypass this.
- [ ] Keep the token file mode `0600`, rotate with overlapping tokens, and
      reload with `SIGHUP` (or restart if signals are unavailable).
- [ ] Set `TRUST_PROXY` only to the real proxy address/network (`loopback` for a
      same-host native proxy; the Docker gateway/CIDR for a published port).
- [ ] Keep the default rate, lockout, and concurrency limits unless you have
      measured a reason to change them.
- [ ] Add proxy-level rate limits and alert on `401`/`429` bursts.
- [ ] Leave `/metrics` disabled or deny it at the proxy. If enabled, use a
      separate `MCP_METRICS_TOKEN` and scrape from a trusted network.
- [ ] Confirm `MCP_ALLOWED_HOSTS`/`MCP_ALLOWED_ORIGINS` contain only the public
      name and the exact browser origin.
- [ ] Back up `data/todo.txt` before upgrades and keep a tested restore path.
- [ ] Never put the token in a URL; send only `Authorization: Bearer`.
- [ ] Monitor the `auth_failure_circuit_breaker` log line and the process's
      memory under sustained load.

## Reporting a vulnerability

Please do not open a public issue for security problems. Report them privately
to the maintainers through GitHub's **Security > Report a vulnerability**
advisory flow on the repository, including reproduction steps, affected
versions, and impact. You will receive an acknowledgement as soon as possible;
please allow time for a fix before public disclosure.
