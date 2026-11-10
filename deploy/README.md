# Deployment reference: TLS proxy in front of todo.txt-mcp

These are **reference configurations**, not a turnkey installer. They assume one
user, one app instance, and a TLS-terminating proxy that reaches the app over
loopback. Read [`SECURITY.md`](../SECURITY.md) and the
[`docs/single-user-deployment.md`](../docs/single-user-deployment.md) runbook
before exposing `/mcp` to the internet.

| File | Use |
| --- | --- |
| `Caddyfile` | Caddy 2.10+; automatic certificates, HTTP→HTTPS, HSTS, 64 KiB body cap, optional `rate_limit` plugin, `/metrics` denied. |
| `nginx.conf` | nginx `server` blocks; HTTP→HTTPS, HSTS, `client_max_body_size 64k`, `limit_req`, `/metrics` denied. |

## What the proxy must do

1. Terminate TLS and redirect HTTP to HTTPS.
2. Send `Strict-Transport-Security` on HTTPS responses.
3. Cap request bodies at 64 KiB and enforce header/read timeouts.
4. Rate limit at the edge. The app also has per-client limits; the proxy is the
   first line and still works while the app restarts.
5. Forward the public `Host` header and the real client IP in
   `X-Forwarded-For` (replace any client-supplied value).
6. Return `404` for `/metrics` unless you explicitly enabled it **and** use a
   separate `MCP_METRICS_TOKEN`.
7. Proxy to `127.0.0.1:3000`; never publish the app port on a public interface.

## App settings that must match

```bash
HOST=0.0.0.0                 # only for the private proxy hop / container
PORT=3000
MCP_ALLOWED_HOSTS=todo.example.com
MCP_ALLOWED_ORIGINS=https://todo.example.com   # only if a browser client is used
MCP_AUTH_TOKEN_FILE=/run/secrets/mcp_auth_token
TRUST_PROXY=loopback         # same-host native proxy; see the caveat below
MCP_METRICS_ENABLED=0        # default when HOST is non-loopback
```

### `TRUST_PROXY` caveat for Docker

`TRUST_PROXY=loopback` is correct when the proxy and the Node process share the
host's loopback interface. A container with a published
`127.0.0.1:3000:3000` port usually sees the **Docker bridge gateway** (often
`172.17.0.1`) as its peer, not `127.0.0.1`. In that case set `TRUST_PROXY` to the
gateway or the proxy's exact address/CIDR. Confirm with the structured
`msg:"request"` log line:

```bash
docker compose -f docker-compose.deploy.yml logs -f todo-txt-mcp |
  grep '"msg":"request"'
```

The `ip` field must be the real client address. If every request shows the
Docker gateway, `TRUST_PROXY` is not trusted and all clients share one rate
limit/lockout bucket.

## Caddy

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

`request_body { max_size 64KB }` requires Caddy 2.10+. The `rate_limit` block is
commented out because it needs the
[`caddy-ratelimit`](https://github.com/mholt/caddy-ratelimit) plugin, which is
not part of the standard build. The app's per-client limit stays active without
it.

## nginx

```bash
sudo cp deploy/nginx.conf /etc/nginx/conf.d/todo-txt-mcp.conf
sudo nginx -t
sudo systemctl reload nginx
```

Obtain certificates with your usual ACME client (for example Certbot) and update
the `ssl_certificate` paths. The `limit_req_zone` must remain in the `http`
context; `conf.d/*.conf` is included there by the default nginx configuration.

## Verification checklist

- [ ] `curl -I http://todo.example.com/mcp` returns a `301`/`308` to HTTPS.
- [ ] `curl -I https://todo.example.com/mcp` includes
      `Strict-Transport-Security`.
- [ ] `curl -o /dev/null -w '%{http_code}\n' https://todo.example.com/mcp`
      returns `401` without a token.
- [ ] A request with a 65 KiB body returns `413` at the proxy.
- [ ] `https://todo.example.com/metrics` returns `404` by default.
- [ ] `docker compose ... logs` shows the real client `ip`, not the proxy IP.
- [ ] `401`/`429` spikes and the `auth_failure_circuit_breaker` line are visible
      in logs/alerts.
