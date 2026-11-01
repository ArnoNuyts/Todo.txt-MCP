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
  `add_todos` rejects an add that would exceed this limit and saves nothing.

### File configuration example

```json
{
  "backend": "local",
  "local": {
    "filename": "todo.txt"
  }
}
```

## 🔐 Read-only mode, tool profiles, and token footprint

- **Read-only:** `MCP_READ_ONLY=1` exposes only `list_todos`; mutating tools are
  not registered.
- **Tool profiles:** `MCP_TOOLSET=full|core|readonly|off` controls the exposed
  toolset. `off` exposes resources only, `readonly` the five read tools, `core`
  the read tools plus add/update/status/delete, and `full` (default) every
  tool. Combine this with a gateway or per-agent MCP config to expose the server
  only on demand.
- **Output schemas:** `MCP_OUTPUT_SCHEMAS=1` adds `outputSchema` to
  `tools/list`. Off by default because it is roughly half of the tool-definition
  payload; structured content is returned either way.
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

- `list_todos` — list, filter, search, and paginate todos. Responses include
  the current content `version`. `limit` defaults to `50`; `format` defaults to
  `"structured"` (use `"text"` or `"both"` when needed).
- `add_todos` — add one or more todos. Accepts `onDuplicate`
  (`"allow"` default, `"skip"`, or `"error"`) and an optional `idempotencyKey`
  stored as an `idem:<key>` tag so retries return the previously added todos.
- `update_todos` — replace the text of one or more todos by hash.
- `set_todo_statuses` — mark a batch of todos done or active with one
  load/save cycle.
- `delete_todos` — delete a batch of todos by hash with one load/save cycle.
  Pass `dryRun: true` to preview the deletion without writing.
- `delete_completed` — delete completed todos, optionally filtered by
  `before: "YYYY-MM-DD"` and/or `context`. Supports `dryRun`.
- `get_todo` — fetch one todo and the current content `version`.
- `summary` — counts by status, context, project, and priority, plus overdue.
- `export_todos` — return the whole todo.txt `content` and its `version`.
- `changes_since` — compare a known `version` with the current one; when it
  changed, the new content is included.
- `import_todos` — import todo.txt content in `merge` or `replace` mode.
  Supports `expectedVersion` (a mismatch fails with `CONFLICT`) and `dryRun`,
  which returns an add/remove/unchanged diff without writing.

Batch tools return `succeeded` and `failed` arrays alongside their legacy
`edited`/`updated`/`deleted`/`missing` fields. A missing hash is reported with
the `TODO_NOT_FOUND` code and a hint to refresh hashes with `list_todos`.

Failures return `isError: true` with a stable machine-readable code in
`structuredContent.error`: `TODO_NOT_FOUND`, `INVALID_ARGUMENT`,
`LIMIT_EXCEEDED`, `CONFLICT`, `BACKEND_ERROR`, or `UNSUPPORTED`.

### MCP resources

Read-only resources are always available, including in read-only mode:

- `todo://file` — the complete todo.txt content.
- `todo://active` — open todos only.
- `todo://context/{name}` — open todos in one `@context`.

### Concurrency

Every mutating tool performs `load -> mutate -> save` inside an in-process
queue. The local-file backend additionally takes an advisory `<file>.lock`
around that cycle, so two processes sharing the same file cannot silently
overwrite each other. The lock is released in a `finally`; a lock older than
30 seconds is treated as abandoned.

The WebDAV backend sends `If-Match` with the ETag from the last load. A `412
Precondition Failed` is returned as a `CONFLICT` tool error, so clients know to
reload with `list_todos` before retrying. Item-scoped tools do **not** require a
client-supplied `expectedVersion`: they address the exact version through the
item hash. `import_todos` keeps `expectedVersion` because it replaces or merges
a full-file snapshot supplied by the client.

### Exposing the server on demand

The smallest footprint is not connecting the MCP server at all until it is
needed. Two supported patterns:

1. **Client/agent profile:** keep the server disabled in the default agent
   configuration (`enabled: false`) and enable it per agent, command, or
   session. This removes all tool definitions from every request where the
   server is not used.
2. **Gateway or profile:** run behind an MCP gateway that connects servers on
   demand, or start the container with `MCP_TOOLSET=off` and switch to
   `core`/`full` only for the sessions that need write access.

Version 2.0 removes the deprecated singular aliases (`add_todo`, `edit_todo`,
`set_todo_status`, `delete_todo`). Use the plural canonical names instead.

## 🛠️ Testing with MCP Inspector

1. **Start the server** with Docker or `npm start`.
2. **Run the Inspector**:
   ```bash
   npx @modelcontextprotocol/inspector http://localhost:3000/mcp
   ```
3. Use the Inspector UI to list and execute the tools.
