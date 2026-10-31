# Todo.txt-MCP

Todo.txt-MCP is a [Model Context Protocol](https://modelcontextprotocol.io)
(MCP) server for managing a `todo.txt` file. It lets AI agents list, add, edit,
and complete tasks. Todos can be stored in a local file or synchronized over
WebDAV.

The server runs on **Node.js 26 LTS** and executes TypeScript directly using
Node's built-in type stripping, so there is no build step. The minimum supported
runtime is Node.js 24.15.

## 🚀 Quick Start with Docker

```yaml
services:
  todo-txt-mcp:
    build: https://github.com/ArnoNuyts/Todo.txt-MCP.git
    ports:
      # Loopback only; put a TLS reverse proxy in front to expose it.
      - "127.0.0.1:3000:3000"
    volumes:
      # Mount a directory so atomic file replacement works.
      - ./data:/data
    environment:
      - HOST=0.0.0.0
      - MCP_ALLOWED_HOSTS=localhost,127.0.0.1
      - MCP_ALLOWED_ORIGINS=http://localhost:3000
      - TODOTXT_MCP_BACKEND=local
      - TODOTXT_MCP_LOCAL_FILENAME=/data/todo.txt
      # Required: the server refuses to start without an auth token.
      - MCP_AUTH_TOKEN=${MCP_AUTH_TOKEN:?set MCP_AUTH_TOKEN}
      # - TODOTXT_MCP_BACKEND=webdav
      # - TODOTXT_MCP_WEBDAV_URL=https://dav.example.com
      # - TODOTXT_MCP_WEBDAV_USERNAME=user
      # - TODOTXT_MCP_WEBDAV_PASSWORD=pass
```

1. **Run**:
   ```bash
   mkdir -p data
   cp todo.txt.example data/todo.txt
   export MCP_AUTH_TOKEN="$(openssl rand -hex 32)"
   docker compose up -d
   ```
2. **Access**: the server listens at `http://localhost:3000`.
3. **MCP endpoint**: `http://localhost:3000/mcp`

Authentication is **required**. The server refuses to start unless
`MCP_AUTH_TOKEN`, `MCP_AUTH_TOKENS`, or `MCP_AUTH_TOKEN_FILE` is set. Clients
must send `Authorization: Bearer <token>`.

> The container runs as the unprivileged `node` user (UID 1000). If `data/` is
> not writable by that user, adjust its ownership, for example
> `sudo chown -R 1000:1000 data`.

See [SECURITY.md](SECURITY.md) for Host/Origin allowlists, bearer-token auth,
and reverse-proxy TLS guidance.

## 💻 Run Locally

Requirements:

- [Node.js](https://nodejs.org) **26 LTS** (minimum 24.15)
- npm 12

```bash
npm ci
export MCP_AUTH_TOKEN="$(openssl rand -hex 32)"
npm start
```

The default port is `3000`. Override it with the `PORT` environment variable:

```bash
PORT=8080 npm start
```

If you change the port, update `MCP_ALLOWED_ORIGINS` and the MCP client URL
(for example `http://localhost:3330/mcp`) to match. The examples in this repo
assume `3000`.

For development with automatic restarts:

```bash
npm run dev
```

## 🧪 Testing

The test suite uses [Vitest](https://vitest.dev).

```bash
npm test              # run once
npm run test:watch    # watch mode
npm run test:coverage # coverage report
npm run typecheck     # TypeScript type checking
```

## ⚙️ Configuration

Configuration is read from `todo.txt-mcp-config.json` in the working directory
(optional), then overridden by environment variables. See
`todo.txt-mcp-config.example.json`.

### Local File Backend (Default)

Stores todos in a local text file.

- `TODOTXT_MCP_BACKEND`: Set to `local`.
- `TODOTXT_MCP_LOCAL_FILENAME`: Path to the todo file (default: `todo.txt`).

### WebDAV Backend

Syncs todos with a WebDAV server (e.g., Nextcloud).

- `TODOTXT_MCP_BACKEND`: Set to `webdav`.
- `TODOTXT_MCP_WEBDAV_URL`: Full URL to the WebDAV resource (e.g.,
  `https://cloud.example.com/remote.php/dav/files/user/todo.txt`).
- `TODOTXT_MCP_WEBDAV_USERNAME`: WebDAV username.
- `TODOTXT_MCP_WEBDAV_PASSWORD`: WebDAV password.

### Resource Limits

Both backends enforce size guardrails so a runaway file or agent cannot
exhaust the process memory:

- `TODOTXT_MCP_MAX_FILE_BYTES`: Maximum size of the todo file in bytes
  (default: `1048576`, i.e. 1 MiB). An oversized file is rejected before it is
  parsed.
- `TODOTXT_MCP_MAX_TODOS`: Maximum total number of todos (default: `10000`).
  `add_todo` rejects an add that would exceed this limit and saves nothing.

### File configuration example

```json
{
  "backend": "local",
  "local": {
    "filename": "todo.txt"
  }
}
```

## 🔐 Read-only mode, token rotation, and observability

- **Read-only:** `MCP_READ_ONLY=1` exposes only `list_todos`; mutating tools are
  not registered.
- **Token rotation:** keep several bearers active with
  `MCP_AUTH_TOKENS=old-token,new-token`, or mount a secret with
  `MCP_AUTH_TOKEN_FILE=/run/secrets/mcp_auth_tokens` (takes precedence).
  Environment/file tokens must be at least 32 characters unless
  `MCP_ALLOW_WEAK_TOKEN=1`.
- **Logs:** structured JSON to stdout/stderr; set `MCP_LOG_LEVEL` to `debug`,
  `info` (default), `warn`, or `error`. Tokens, request bodies, and todo content
  are never logged.
- **Metrics:** `GET /metrics` serves in-memory Prometheus counters
  (`todo_mcp_requests_total`, auth failures, and response classes). It requires
  the bearer token when authentication is enabled and is open otherwise, so keep
  the server on loopback or scrape it through the protected proxy.

See [SECURITY.md](SECURITY.md) for rotation, file permissions, and exposure
guidance.

## 🔧 Available Tools

- `list_todos` — list, filter, search, and paginate todos.
- `add_todo` — add one or more todos.
- `edit_todo` — replace the text of one or more todos by hash.
- `set_todo_status` — mark todos done or active.
- `delete_todo` — delete a todo by hash.

## 🛠️ Testing with MCP Inspector

1. **Start the server** with Docker or `npm start`.
2. **Run the Inspector**:
   ```bash
   npx @modelcontextprotocol/inspector http://localhost:3000/mcp
   ```
3. Use the Inspector UI to list and execute the tools.
