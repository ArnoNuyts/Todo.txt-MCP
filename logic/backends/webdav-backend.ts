import type { TodoBackend } from "../backend.ts";
import { Todo } from "../todo.ts";
import { Todos } from "../Todos.ts";

export class WebDavBackend implements TodoBackend {
  private readonly url: string;
  private readonly username?: string;
  private readonly password?: string;

  constructor(url: string, username?: string, password?: string) {
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
    });

    if (!response.ok) {
      if (response.status === 404) {
        return new Todos();
      }
      throw new Error(
        `Failed to load todos from WebDAV: ${response.status} ${response.statusText}`,
      );
    }

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
    const response = await fetch(this.url, {
      method: "PUT",
      headers: {
        ...this.getHeaders(),
        "Content-Type": "text/plain",
      },
      body: content,
    });

    if (!response.ok) {
      throw new Error(
        `Failed to save todos to WebDAV: ${response.status} ${response.statusText}`,
      );
    }
  }
}
