# TodoTui MCP Server

TodoTui is a Model Context Protocol (MCP) server designed to manage your todo
list. It enables AI agents to interact with your tasks—listing, adding, editing,
and marking them as done. It supports storage via a local `todo.txt` file or
synchronization over WebDAV.

## 🚀 Quick Start with Docker

The easiest way to run TodoTui is using Docker Compose.

1. **Configure**: (Optional) Edit `docker-compose.yml` to set environment
   variables for WebDAV or change the local filename.
2. **Run**:
   ```bash
   docker-compose up -d
   ```
3. **Access**: The server will be running at `http://localhost:5000`.

## 💻 Run Locally

If you have Deno installed, you can run the server directly.

1. **Install Deno**: [https://deno.com/runtime](https://deno.com/runtime)
2. **Run**:
   ```bash
   deno run --allow-net --allow-read --allow-write --allow-env server.ts
   ```
   By default, it runs on port `3000`. You can change this by setting the `PORT`
   environment variable.

## ⚙️ Configuration

You can configure the backend using environment variables. This is especially
useful when running with Docker.

### Local File Backend (Default)

Stores todos in a local text file.

- `TODOTUI_BACKEND`: Set to `local`.
- `TODOTUI_LOCAL_FILENAME`: Path to the todo file (default: `todo.txt`).

### WebDAV Backend

Syncs todos with a WebDAV server (e.g., Nextcloud).

- `TODOTUI_BACKEND`: Set to `webdav`.
- `TODOTUI_WEBDAV_URL`: Full URL to the WebDAV resource (e.g.,
  `https://cloud.example.com/remote.php/dav/files/user/todo.txt`).
- `TODOTUI_WEBDAV_USERNAME`: WebDAV username.
- `TODOTUI_WEBDAV_PASSWORD`: WebDAV password.

## 🛠️ Testing with MCP Inspector

You can verify that the server is working correctly using the MCP Inspector.

1. **Start the server** (Docker or Local).
2. **Run the Inspector**:
   ```bash
   npx @modelcontextprotocol/inspector http://localhost:5000/mcp
   ```
   _(Replace port `5000` with `3000` if running locally without Docker)_

This will open a web interface where you can list available tools (`list_todos`,
`add_todo`, etc.) and execute them to test the functionality.
