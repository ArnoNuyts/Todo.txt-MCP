import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Todo } from "../logic/todo.ts";
import { addTodosHandler, updateTodosHandler } from "../logic/tools.ts";
import { MockBackend } from "./helpers/mock-backend.ts";

interface ToolResultLike {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: { error?: { code?: string } };
}

function errorCodeOf(result: unknown): string | undefined {
  return (result as ToolResultLike).structuredContent?.error?.code;
}

function textOf(result: unknown): string {
  return (result as ToolResultLike).content
    .map((item) => item.text ?? "")
    .join("\n");
}

function snapshot(backend: MockBackend): string[] {
  return backend.getTodos().map((todo) => todo.toString());
}

const SEPARATORS = [
  { name: "line feed", value: "\n" },
  { name: "carriage return", value: "\r" },
  { name: "line separator", value: "\u2028" },
  { name: "paragraph separator", value: "\u2029" },
];

describe("todo line invariants", () => {
  let backend: MockBackend;

  beforeEach(() => {
    backend = new MockBackend();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(SEPARATORS)(
    "rejects an embedded $name in add_todos without saving",
    async ({ value }) => {
      await backend.save([new Todo("keep me")]);
      const before = snapshot(backend);
      const saveSpy = vi.spyOn(backend, "save");

      const result = await addTodosHandler(backend, {
        todos: [`alpha${value}beta`],
      });

      expect(result).toMatchObject({ isError: true });
      expect(errorCodeOf(result)).toBe("INVALID_ARGUMENT");
      expect(textOf(result)).toMatch(/must be a single line/);
      expect(textOf(result)).toContain("Nothing was saved");
      expect(saveSpy).not.toHaveBeenCalled();
      expect(snapshot(backend)).toEqual(before);
    },
  );

  it.each(SEPARATORS)(
    "rejects an embedded $name in update_todos without saving",
    async ({ value }) => {
      const todo = new Todo("keep me @home");
      await backend.save([todo]);
      const hash = await todo.getHash();
      const before = snapshot(backend);
      const saveSpy = vi.spyOn(backend, "save");

      const result = await updateTodosHandler(backend, {
        updates: [`${hash} renamed${value}injected @home`],
      });

      expect(result).toMatchObject({ isError: true });
      expect(errorCodeOf(result)).toBe("INVALID_ARGUMENT");
      expect(textOf(result)).toMatch(/must be a single line/);
      expect(textOf(result)).toContain("Nothing was saved");
      expect(saveSpy).not.toHaveBeenCalled();
      expect(snapshot(backend)).toEqual(before);
    },
  );

  it("rejects a multi-line add that would bypass TODOTXT_MCP_MAX_TODOS", async () => {
    vi.stubEnv("TODOTXT_MCP_MAX_TODOS", "3");
    await backend.save([new Todo("one")]);
    const before = snapshot(backend);
    const saveSpy = vi.spyOn(backend, "save");

    // One input element, but two persisted lines: the old element-count check
    // saw 1 + 1 <= 3 and accepted it.
    const result = await addTodosHandler(backend, { todos: ["two\nthree"] });

    expect(result).toMatchObject({ isError: true });
    expect(errorCodeOf(result)).toBe("INVALID_ARGUMENT");
    expect(saveSpy).not.toHaveBeenCalled();
    expect(snapshot(backend)).toEqual(before);
  });

  it("preserves every value of a duplicate tag across an add", async () => {
    await backend.save([new Todo("task k:1 k:2")]);

    const result = await addTodosHandler(backend, { todos: ["another"] });

    expect(result).not.toMatchObject({ isError: true });
    const [seeded] = backend.getTodos();
    expect(seeded.toString()).toBe("task k:1 k:2");
    expect(seeded.tags).toEqual({ k: ["1", "2"] });
  });

  it("still accepts single-line Unicode, tabs, and NUL", async () => {
    const text = "🚀 café e\u0301 مرحبا\twith\ttabs\u0000end";

    const result = await addTodosHandler(backend, { todos: [text] });

    expect(result).not.toMatchObject({ isError: true });
    expect(backend.getTodos()).toHaveLength(1);
    expect(backend.getTodos()[0].text).toBe(text);
  });
});
