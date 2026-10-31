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
- **Origin allowlist.** Cross-origin browser requests are only allowed from
  `http://localhost:3000` by default. Requests without an `Origin` header
  (command-line clients, MCP clients) continue to work. CORS never emits
  `Access-Control-Allow-Origin: *`. If `MCP_ALLOWED_ORIGINS` is empty, no CORS
  headers are emitted and any request that carries an `Origin` header is
  rejected with a `403`; clients without an `Origin` header still work.
- **Request body limit.** Request bodies are capped at 64 KiB.
- The server is stateless (`sessionIdGenerator: undefined`) and returns JSON
  responses rather than long-lived SSE streams.
- `/mcp` and `/metrics` send `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, and `Cache-Control: no-store`; the framework
  name is not advertised. Structured logs never include tokens, bodies, or todo
  content.
- `GET /healthz` returns `{"status":"ok"}` for health checks and is never
  authenticated. `GET /metrics` is also unauthenticated when no token is
  configured, so keep the process on loopback.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Interface to bind to. Use `0.0.0.0` only inside a container or behind a proxy. |
| `PORT` | `3000` | Listen port (integer 0-65535). |
| `MCP_ALLOWED_HOSTS` | `localhost,127.0.0.1,[::1]` | Comma-separated hostnames accepted in the `Host` header. Hostnames only, no ports. |
| `MCP_ALLOWED_ORIGINS` | `http://localhost:3000` | Comma-separated origins allowed for browser clients. Empty disables CORS entirely. |
| `MCP_AUTH_TOKEN` | unset | Single bearer token. When set, `/mcp` and `/metrics` require `Authorization: Bearer <token>`. |
| `MCP_AUTH_TOKENS` | unset | Comma/whitespace separated list of active tokens for rotation. Takes precedence over `MCP_AUTH_TOKEN`. |
| `MCP_AUTH_TOKEN_FILE` | unset | File containing one or more tokens. Takes precedence over both environment variables. Keep it mode `0600`. |
| `MCP_ALLOW_WEAK_TOKEN` | unset | Set to `1` to allow environment/file tokens shorter than 32 characters. |
| `MCP_READ_ONLY` | unset | Set to `1` to expose only `list_todos`; mutating tools are not registered. |
| `MCP_LOG_LEVEL` | `info` | Structured JSON log level: `debug`, `info`, `warn`, or `error`. |
| `TRUST_PROXY` | `false` | Express `trust proxy` setting. Accepts `false`, `true`, a hop count, `loopback`, or an IP/CIDR list. Leave unset/false unless a trusted proxy is in front. |
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

## Enabling authentication

Authentication is **optional**, but recommended as soon as the endpoint is
reachable by anything other than the local user. The server logs a warning at
startup when none of `MCP_AUTH_TOKEN`, `MCP_AUTH_TOKENS`, or
`MCP_AUTH_TOKEN_FILE` is set.

Set a long, random token and pass it to clients as a bearer token:

```bash
# Generate a token
openssl rand -hex 32

# Run locally
MCP_AUTH_TOKEN="$(openssl rand -hex 32)" npm start
```

Or via Docker Compose:

```yaml
environment:
  - MCP_AUTH_TOKEN=${MCP_AUTH_TOKEN:?set MCP_AUTH_TOKEN}
```

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

### Token rotation

Several tokens can be active at once. A request is authorized when it matches
**any** configured token, so rotation does not require a flag day:

```bash
# Accept both the old and new token while clients are updated.
MCP_AUTH_TOKENS="$(cat old-token.txt),$(openssl rand -hex 32)" npm start
```

Once every client uses the new token, remove the old one and restart. Precedence
is `MCP_AUTH_TOKEN_FILE` > `MCP_AUTH_TOKENS` > `MCP_AUTH_TOKEN`; a token file
wins so a stale environment list cannot keep an old secret valid.

### File-based secrets

For containers and secret managers, point the server at a file instead of
passing the secret in the environment:

```bash
install -m 600 /dev/null /run/secrets/mcp_auth_tokens
openssl rand -hex 32 > /run/secrets/mcp_auth_tokens
MCP_AUTH_TOKEN_FILE=/run/secrets/mcp_auth_tokens npm start
```

The file may contain one token per line or a comma/whitespace separated list.
The server warns once at startup if the file is readable by group or other on
POSIX, and refuses to start if the file is missing, empty, or unreadable.
Environment/file tokens shorter than 32 characters are rejected unless
`MCP_ALLOW_WEAK_TOKEN=1` is set explicitly. Explicit programmatic options (used
by the test suite) are exempt from the length check.

## Read-only mode

Set `MCP_READ_ONLY=1` to publish only `list_todos`. The mutating tools
(`add_todo`, `edit_todo`, `set_todo_status`, `delete_todo`) are not registered,
so they do not appear in `tools/list` and cannot be called. This is useful for
dashboards, read-only agents, and exposing the todo file to a model that should
only be able to inspect it. Read-only mode does not replace authentication; the
endpoint still requires a bearer token when one is configured.

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

Counters are per process and reset on restart. When a token is configured,
`/metrics` requires the same bearer token as `/mcp`; when authentication is
disabled the endpoint is open, matching the local-first default. Because metrics
can reveal traffic patterns, keep the server bound to loopback or place
`/metrics` behind the same TLS proxy and bearer token you use for `/mcp`. Both
`/mcp` and `/metrics` send `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`, and `Cache-Control: no-store`.

## TLS via reverse proxy

The server speaks plain HTTP. To expose it beyond the local machine, put a TLS
terminating reverse proxy in front of it and keep the app bound to loopback.

Example with Caddy:

```caddyfile
todo.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Example with nginx:

```nginx
server {
    listen 443 ssl;
    server_name todo.example.com;

    ssl_certificate     /etc/ssl/certs/todo.example.com.pem;
    ssl_certificate_key /etc/ssl/private/todo.example.com.key;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Guidance:

- Keep the proxy and the MCP server on the same host / private network; do not
  publish the app port on a public interface.
- Forward the original `Host` header (`proxy_set_header Host $host;`) and add
  the public hostname to `MCP_ALLOWED_HOSTS`.
- Terminate TLS at the proxy, keep certificates up to date, and redirect HTTP
  to HTTPS.
- Combine TLS with `MCP_AUTH_TOKEN`; TLS protects the token in transit, the
  token protects the endpoint from unauthorized callers.
- If the proxy and server are on different hosts, set `HOST=0.0.0.0` (or the
  private interface) for the server and firewall the port so only the proxy
  can reach it.

## Public exposure limits

When `/mcp` is reachable by anything other than the local user, the server
applies in-process abuse controls before authentication. They protect the
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
breaker: `/mcp` returns `503` with `Retry-After` and a loud security log line
until `MCP_GLOBAL_AUTH_FAIL_BAN_SEC` elapses. This catches distributed guessing
that per-key limits cannot see.

**Concurrency cap.** At most `MCP_MAX_CONCURRENCY` `POST /mcp` requests may be
in flight. Additional work is rejected immediately with `503` and
`Retry-After: 1` instead of piling up behind the in-process backend lock.

**Connection timeouts.** After `listen()`, the server sets
`requestTimeout = 15s`, `headersTimeout = 10s`, and `keepAliveTimeout = 5s` to
cut off slow-header and slow-body connections.

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
`X-Forwarded-For` headers would defeat the rate limiter and lockout.

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
- [ ] Set a long random token (`MCP_AUTH_TOKEN`, `MCP_AUTH_TOKENS`, or
      `MCP_AUTH_TOKEN_FILE`); never run exposed without one.
- [ ] Keep token files mode `0600` and rotate with overlapping tokens.
- [ ] Set `TRUST_PROXY` only to the real proxy address/network.
- [ ] Keep the default rate, lockout, and concurrency limits unless you have
      measured a reason to change them.
- [ ] Add proxy-level rate limits and alert on `401`/`429` bursts.
- [ ] Scrape `/metrics` from loopback or protect it with the bearer token.
- [ ] Monitor the `auth_failure_circuit_breaker` log line and the process's
      memory under sustained load.
- [ ] Use `MCP_READ_ONLY=1` when a client only needs to list todos.

## Reporting a vulnerability

Please do not open a public issue for security problems. Report them privately
to the maintainers through GitHub's **Security > Report a vulnerability**
advisory flow on the repository, including reproduction steps, affected
versions, and impact. You will receive an acknowledgement as soon as possible;
please allow time for a fix before public disclosure.
