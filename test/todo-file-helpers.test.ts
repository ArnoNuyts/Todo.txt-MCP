import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readTodosFromFile,
  writeTodosToFile,
} from "../logic/todo-file-helpers.ts";
import { Todo } from "../logic/todo.ts";

describe("todo-file-helpers", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "todo-txt-mcp-"));
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("readTodosFromFile - should return empty Todos and create file if not found", async () => {
    const filename = join(tempDir, "missing.txt");

    const todos = await readTodosFromFile(filename);

    expect(todos.length).toBe(0);

    // Check if the file was created
    const fileInfo = await stat(filename);
    expect(fileInfo.isFile()).toBe(true);
  });

  it("writeTodosToFile / readTodosFromFile - should round-trip todos", async () => {
    const filename = join(tempDir, "todos.txt");
    const todos = [
      new Todo("first todo +project @context"),
      new Todo("x second todo"),
    ];

    await writeTodosToFile(todos, filename);
    const readBack = await readTodosFromFile(filename);

    expect(readBack.length).toBe(2);
    expect(readBack[0].text).toBe("first todo +project @context");
    expect(readBack[0].projects.has("project")).toBe(true);
    expect(readBack[0].contexts.has("context")).toBe(true);
    expect(readBack[1].text).toBe("second todo");
    expect(readBack[1].isDone()).toBe(true);
  });

  it("readTodosFromFile - should reject when the file cannot be read", async () => {
    // A directory exists but cannot be read as a text file (EISDIR).
    const directory = join(tempDir, "a-directory");
    await mkdir(directory);

    await expect(readTodosFromFile(directory)).rejects.toThrow(
      /Error reading file/,
    );
  });

  it("writeTodosToFile - leaves no temporary files behind", async () => {
    const filename = join(tempDir, "todos.txt");

    await writeTodosToFile([new Todo("task")], filename);

    expect(await readdir(tempDir)).toEqual(["todos.txt"]);
  });

  it("writeTodosToFile - removes the temporary file when the rename fails", async () => {
    // The target is a directory, so renaming the temp file over it fails.
    const filename = join(tempDir, "target-dir");
    await mkdir(filename);

    await expect(writeTodosToFile([new Todo("task")], filename)).rejects
      .toThrow();

    expect(await readdir(tempDir)).toEqual(["target-dir"]);
  });

  it("writeTodosToFile - forwards write options", async () => {
    const filename = join(tempDir, "todos.txt");

    await writeTodosToFile([new Todo("task")], filename, {
      encoding: "utf8",
      mode: 0o600,
    });

    const fileInfo = await stat(filename);
    expect(fileInfo.mode & 0o777).toBe(0o600);
  });
});
