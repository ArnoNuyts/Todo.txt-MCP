import type { TodoBackend } from "../backend.ts";
import { Todo } from "../todo.ts";
import { Todos } from "../Todos.ts";

const FETCH_TIMEOUT_MS = 10_000;
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export class WebDavBackend implements TodoBackend {
  private readonly url: string;
  private readonly username?: string;
  private readonly password?: string;
  private etag: string | undefined;

  constructor(url: string, username?: string, password?: string) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch (error) {
      throw new Error(`Invalid WebDAV URL "${url}".`, { cause: error });
    }

    const isLocal = LOCAL_HOSTNAMES.has(parsedUrl.hostname);
    if (parsedUrl.protocol !== "https:" && !isLocal) {
      throw new Error(
        `WebDAV URL must use https:// (got "${parsedUrl.protocol}//${parsedUrl.hostname}"). ` +
          "Plain http:// is only allowed for localhost, 127.0.0.1, or ::1.",
      );
    }

    this.url = url;
    this.username = username;
    this.password = password;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.username && this.password) {
      const encoded = Buffer.from(
        `${this.username}:${this.password}`,
      ).toString("base64");
      headers["Authorization"] = `Basic ${encoded}`;
    }
    return headers;
  }

  async load(): Promise<Todo[]> {
    const response = await fetch(this.url, {
      method: "GET",
      headers: this.getHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      if (response.status === 404) {
        this.etag = undefined;
        return new Todos();
      }
      throw new Error(
        `Failed to load todos from WebDAV: ${response.status} ${response.statusText}`,
      );
    }

    this.etag = response.headers.get("ETag") ?? undefined;

    const text = await response.text();
    return new Todos(
      ...text
        .split("\n")
        .filter((x) => x.trim())
        .map((x) => new Todo(x)),
    );
  }

  async save(todos: Todo[]): Promise<void> {
    const content = todos.map((y) => y.toString()).join("\n") + "\n";
    const headers: Record<string, string> = {
      ...this.getHeaders(),
      "Content-Type": "text/plain",
    };
    if (this.etag) {
      headers["If-Match"] = this.etag;
    }

    const response = await fetch(this.url, {
      method: "PUT",
      headers,
      body: content,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (response.status === 412) {
      throw new Error(
        "WebDAV conflict: the todo file was modified remotely " +
          "(412 Precondition Failed). Reload the todos and try again.",
      );
    }

    if (!response.ok) {
      throw new Error(
        `Failed to save todos to WebDAV: ${response.status} ${response.statusText}`,
      );
    }

    this.etag = response.headers.get("ETag") ?? this.etag;
  }
}
