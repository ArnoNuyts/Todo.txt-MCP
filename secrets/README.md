# Secrets

`docker-compose.deploy.yml` expects the bearer token in:

```text
secrets/mcp_auth_token.txt
```

Create it on the host before the first start:

```bash
install -d -m 700 secrets
openssl rand -hex 32 > secrets/mcp_auth_token.txt
chmod 600 secrets/mcp_auth_token.txt
```

The directory is ignored by git except for this file, `.gitkeep`, and
`.gitignore`. Never commit a real token. Docker Compose mounts the file as a
read-only secret at `/run/secrets/mcp_auth_token`; the app reads it through
`MCP_AUTH_TOKEN_FILE`.

For rotation and revocation, see
[`docs/single-user-deployment.md`](../docs/single-user-deployment.md).
