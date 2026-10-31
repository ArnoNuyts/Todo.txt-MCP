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
  `Access-Control-Allow-Origin: *`; if `MCP_ALLOWED_ORIGINS` is empty, no CORS
  headers are emitted at all.
- **Request body limit.** Request bodies are capped at 64 KiB.
- The server is stateless (`sessionIdGenerator: undefined`) and returns JSON
  responses rather than long-lived SSE streams.
- `GET /healthz` returns `{"status":"ok"}` for health checks and is never
  authenticated.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Interface to bind to. Use `0.0.0.0` only inside a container or behind a proxy. |
| `PORT` | `3000` | Listen port (integer 0-65535). |
| `MCP_ALLOWED_HOSTS` | `localhost,127.0.0.1,[::1]` | Comma-separated hostnames accepted in the `Host` header. Hostnames only, no ports. |
| `MCP_ALLOWED_ORIGINS` | `http://localhost:3000` | Comma-separated origins allowed for browser clients. Empty disables CORS entirely. |
| `MCP_AUTH_TOKEN` | unset | When set, `/mcp` requires `Authorization: Bearer <token>`. |

When `MCP_ALLOWED_HOSTS` is set explicitly, include every name clients use. For
example, to reach the server through a TLS proxy at `https://todo.example.com`,
set `MCP_ALLOWED_HOSTS=todo.example.com` (and keep `localhost,127.0.0.1` if you
still connect locally), and add `https://todo.example.com` to
`MCP_ALLOWED_ORIGINS` if a browser client is used.

## Enabling authentication

Authentication is **optional**, but recommended as soon as the endpoint is
reachable by anything other than the local user. The server logs a warning at
startup when `MCP_AUTH_TOKEN` is unset.

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
error body. Comparisons are constant-time. `MCP_AUTH_TOKEN` is a single shared
secret: rotate it by restarting the server with a new value and updating every
client.

Note that bearer tokens are only as private as the transport. Do not send the
token over plain HTTP across a network you do not trust, and do not commit it
to the repository. `.env` files are ignored by git; `.env.example` documents
the variables without real secrets.

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

## Reporting a vulnerability

Please do not open a public issue for security problems. Report them privately
to the maintainers through GitHub's **Security > Report a vulnerability**
advisory flow on the repository, including reproduction steps, affected
versions, and impact. You will receive an acknowledgement as soon as possible;
please allow time for a fix before public disclosure.
