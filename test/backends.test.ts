import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalFileBackend } from "../logic/backends/local-file-backend.ts";
import { WebDavBackend } from "../logic/backends/webdav-backend.ts";
import { Todo } from "../logic/todo.ts";
import { deleteTodoHandler } from "../server.ts";

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

  it("keeps a completed todo's hash when another todo is deleted", async () => {
    const filename = join(await makeTempDirectory(), "todo.txt");
    const completedLine = "x 2024-06-02 2024-06-01 Completed task";
    await writeFile(filename, `${completedLine}\nOpen task\n`, "utf8");

    const backend = new LocalFileBackend(filename);
    const before = [...await backend.load()];
    const completedBefore = before.find((todo) => todo.isDone())!;
    const openBefore = before.find((todo) => !todo.isDone())!;
    const completedHash = await completedBefore.getHash();

    const result = await deleteTodoHandler(backend, {
      hash: await openBefore.getHash(),
    });
    expect(result).not.toMatchObject({ isError: true });

    const reloaded = [...await backend.load()];
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].toString()).toBe(completedLine);
    expect(await reloaded[0].getHash()).toBe(completedHash);
    expect(await readFile(filename, "utf8")).toBe(`${completedLine}\n`);
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
    expect(fetchMock).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        method: "GET",
        headers: {},
        signal: expect.any(AbortSignal),
      }),
    );
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
    expect(fetchMock).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        method: "PUT",
        headers: {
          Authorization: expectedAuth,
          "Content-Type": "text/plain",
        },
        body: "task\n",
        signal: expect.any(AbortSignal),
      }),
    );
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

  it("rejects plain http URLs for remote hosts", () => {
    expect(() => new WebDavBackend("http://dav.example.com/todo.txt"))
      .toThrow(/https/);
    expect(() => new WebDavBackend("ftp://dav.example.com/todo.txt"))
      .toThrow(/https/);
  });

  it("allows plain http for loopback hosts", () => {
    expect(() => new WebDavBackend("http://localhost:8080/todo.txt"))
      .not.toThrow();
    expect(() => new WebDavBackend("http://127.0.0.1/todo.txt")).not.toThrow();
    expect(() => new WebDavBackend("http://[::1]:8080/todo.txt")).not.toThrow();
  });

  it("rejects invalid URLs", () => {
    expect(() => new WebDavBackend("not a url")).toThrow(/Invalid WebDAV URL/);
  });

  it("sends If-Match with the ETag captured on load", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response("task\n", { status: 200, headers: { ETag: '"v1"' } }),
      )
      .mockResolvedValueOnce(new Response("", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const backend = new WebDavBackend(url);
    await backend.load();
    await backend.save([new Todo("task")]);

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      url,
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({ "If-Match": '"v1"' }),
      }),
    );
  });

  it("does not send If-Match before an ETag has been seen", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await new WebDavBackend(url).save([new Todo("task")]);

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ];
    expect(init.headers).not.toHaveProperty("If-Match");
  });

  it("reports a conflict when save fails with 412", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response("task\n", { status: 200, headers: { ETag: '"v1"' } }),
      )
      .mockResolvedValueOnce(
        new Response("", { status: 412, statusText: "Precondition Failed" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const backend = new WebDavBackend(url);
    await backend.load();

    await expect(
      backend.save([new Todo("task")]),
    ).rejects.toThrow(/conflict.*412/i);
  });
});
