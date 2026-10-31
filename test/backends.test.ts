import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalFileBackend } from "../logic/backends/local-file-backend.ts";
import { WebDavBackend } from "../logic/backends/webdav-backend.ts";
import { Todo } from "../logic/todo.ts";

const temporaryDirectories: string[] = [];

async function makeTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "todo-txt-mcp-backend-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("LocalFileBackend", () => {
  it("creates a missing file and returns an empty list", async () => {
    const filename = join(await makeTempDirectory(), "todo.txt");
    const backend = new LocalFileBackend(filename);

    const todos = await backend.load();

    expect(todos).toHaveLength(0);
    expect(await readFile(filename, "utf8")).toBe("");
  });

  it("round-trips todos through the file", async () => {
    const filename = join(await makeTempDirectory(), "todo.txt");
    const backend = new LocalFileBackend(filename);

    await backend.save([new Todo("first @home"), new Todo("x second")]);

    const loaded = await backend.load();
    expect([...loaded].map((todo) => todo.toString())).toEqual([
      "first @home",
      "x second",
    ]);
    expect(await readFile(filename, "utf8")).toBe("first @home\nx second\n");
  });
});

describe("WebDavBackend", () => {
  const url = "https://dav.example.com/todo.txt";

  it("loads todos from a successful response", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("2024-01-01 first\nx done\n", { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const todos = await new WebDavBackend(url).load();

    expect([...todos].map((todo) => todo.toString())).toEqual([
      "2024-01-01 first",
      "x done",
    ]);
    expect(fetchMock).toHaveBeenCalledWith(url, {
      method: "GET",
      headers: {},
    });
  });

  it("returns an empty list when the resource does not exist", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 })),
    );

    await expect(new WebDavBackend(url).load()).resolves.toHaveLength(0);
  });

  it("throws when loading fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500, statusText: "Oops" })),
    );

    await expect(new WebDavBackend(url).load()).rejects.toThrow(
      "Failed to load todos from WebDAV: 500 Oops",
    );
  });

  it("saves with basic auth and text content", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await new WebDavBackend(url, "user", "pass").save([new Todo("task")]);

    const expectedAuth = `Basic ${Buffer.from("user:pass").toString("base64")}`;
    expect(fetchMock).toHaveBeenCalledWith(url, {
      method: "PUT",
      headers: {
        Authorization: expectedAuth,
        "Content-Type": "text/plain",
      },
      body: "task\n",
    });
  });

  it("throws when saving fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500, statusText: "Oops" })),
    );

    await expect(
      new WebDavBackend(url).save([new Todo("task")]),
    ).rejects.toThrow("Failed to save todos to WebDAV: 500 Oops");
  });
});
