import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  listTodosHandler,
  ListTodosOutputShape,
} from "../server.ts";
import { Todo } from "../logic/todo.ts";
import { MockBackend } from "./helpers/mock-backend.ts";

interface ListStructured {
  todos: Array<{ hash: string; text: string }>;
  total: number;
  nextOffset: number | null;
  nextCursor: string | null;
}

function structuredOf(
  result: Awaited<ReturnType<typeof listTodosHandler>>,
): ListStructured {
  if (!("structuredContent" in result) || result.structuredContent === undefined) {
    throw new Error("Expected structured content");
  }
  return result.structuredContent as ListStructured;
}

function textsOf(
  result: Awaited<ReturnType<typeof listTodosHandler>>,
): string[] {
  return result.content[0].text.split("\n").filter((line) => line !== "");
}

describe("list_todos filters, sorting, paging and output format", () => {
  const backend = new MockBackend();

  beforeEach(async () => {
    backend.reset();
    await backend.save([
      new Todo(
        "(B) 2024-01-01 Write report +Work @office due:2024-02-01 prio:high",
      ),
      new Todo(
        "(A) 2024-02-01 Fix bug +work @Home due:2024-03-01 prio:high",
      ),
      new Todo(
        "(C) 2024-03-01 Buy milk +home @Errands due:2023-12-01 prio:low",
      ),
      new Todo("x 2024-04-01 2024-01-15 Old task +archive @office"),
      new Todo("Read book @home"),
    ]);
  });

  it("filters by exact context with or without the leading @", async () => {
    const plain = structuredOf(
      await listTodosHandler(backend, { status: "all", context: "office" }),
    );
    const marked = structuredOf(
      await listTodosHandler(backend, { status: "all", context: "@OFFICE" }),
    );

    expect(plain.total).toBe(2);
    expect(marked.total).toBe(2);
    expect(plain.todos.map((todo) => todo.text)).toEqual(
      marked.todos.map((todo) => todo.text),
    );
  });

  it("filters by exact project with or without the leading +", async () => {
    const result = structuredOf(
      await listTodosHandler(backend, { status: "all", project: "WORK" }),
    );

    expect(result.total).toBe(2);
    for (const todo of result.todos) {
      expect(todo.text.toLowerCase()).toContain("+work");
    }
  });

  it("filters by priority", async () => {
    const result = structuredOf(
      await listTodosHandler(backend, { status: "all", priority: "A" }),
    );

    expect(result.todos).toHaveLength(1);
    expect(result.todos[0].text).toContain("Fix bug");
  });

  it("filters by every requested tag", async () => {
    const high = structuredOf(
      await listTodosHandler(backend, { status: "all", tag: { prio: "high" } }),
    );
    const combined = structuredOf(
      await listTodosHandler(backend, {
        status: "all",
        tag: { prio: "high", due: "2024-03-01" },
      }),
    );

    expect(high.total).toBe(2);
    expect(combined.total).toBe(1);
    expect(combined.todos[0].text).toContain("Fix bug");
  });

  it("filters by dueBefore and createdAfter", async () => {
    const due = structuredOf(
      await listTodosHandler(backend, {
        status: "all",
        dueBefore: "2024-01-01",
      }),
    );
    const created = structuredOf(
      await listTodosHandler(backend, {
        status: "all",
        createdAfter: "2024-02-15",
      }),
    );

    expect(due.total).toBe(1);
    expect(due.todos[0].text).toContain("Buy milk");
    expect(created.total).toBe(1);
    expect(created.todos[0].text).toContain("Buy milk");
  });

  it("combines filters with AND and keeps search over display text", async () => {
    const combined = structuredOf(
      await listTodosHandler(backend, {
        status: "todo",
        project: "home",
        priority: "C",
        tag: { prio: "low" },
      }),
    );
    const excluded = structuredOf(
      await listTodosHandler(backend, { status: "todo", context: "office" }),
    );
    const search = structuredOf(
      await listTodosHandler(backend, { status: "all", search: "prio:high" }),
    );

    expect(combined.total).toBe(1);
    expect(combined.todos[0].text).toContain("Buy milk");
    expect(excluded.total).toBe(1);
    expect(excluded.todos[0].text).toContain("Write report");
    // Tags are part of the display text, so they are searchable.
    expect(search.total).toBe(2);
  });

  it("sorts by creation, completion, priority and text", async () => {
    const creation = structuredOf(
      await listTodosHandler(backend, { status: "all", sort: "creation" }),
    );
    const completion = structuredOf(
      await listTodosHandler(backend, { status: "all", sort: "completion" }),
    );
    const priority = structuredOf(
      await listTodosHandler(backend, { status: "all", sort: "priority" }),
    );
    const text = structuredOf(
      await listTodosHandler(backend, { status: "all", sort: "text" }),
    );

    expect(creation.todos.map((todo) => todo.text)).toEqual([
      "(B) Write report +Work @office due:2024-02-01 prio:high",
      "x 2024-04-01 Old task +archive @office",
      "(A) Fix bug +work @Home due:2024-03-01 prio:high",
      "(C) Buy milk +home @Errands due:2023-12-01 prio:low",
      "Read book @home",
    ]);
    expect(completion.todos[0].text).toContain("Old task");
    expect(priority.todos.map((todo) => todo.text.slice(0, 3))).toEqual([
      "(A)",
      "(B)",
      "(C)",
      "x 2",
      "Rea",
    ]);

    const sortedTexts = text.todos.map((todo) => todo.text);
    expect(sortedTexts).toEqual([...sortedTexts].sort((a, b) => a.localeCompare(b)));
  });

  it("pages with an opaque cursor and ignores offset when a cursor is set", async () => {
    const first = structuredOf(
      await listTodosHandler(backend, {
        status: "all",
        sort: "creation",
        limit: 2,
      }),
    );
    expect(first.total).toBe(5);
    expect(first.nextOffset).toBe(2);
    expect(first.nextCursor).not.toBeNull();

    const second = structuredOf(
      await listTodosHandler(backend, {
        status: "all",
        sort: "creation",
        limit: 2,
        cursor: first.nextCursor as string,
        offset: 999,
      }),
    );
    expect(second.todos.map((todo) => todo.text)).toEqual([
      "(A) Fix bug +work @Home due:2024-03-01 prio:high",
      "(C) Buy milk +home @Errands due:2023-12-01 prio:low",
    ]);
    expect(second.nextOffset).toBe(4);
    expect(second.nextCursor).not.toBeNull();

    const third = structuredOf(
      await listTodosHandler(backend, {
        status: "all",
        sort: "creation",
        limit: 2,
        cursor: second.nextCursor as string,
      }),
    );
    expect(third.todos.map((todo) => todo.text)).toEqual(["Read book @home"]);
    expect(third.nextOffset).toBeNull();
    expect(third.nextCursor).toBeNull();
  });

  it("rejects an invalid cursor", async () => {
    await expect(
      listTodosHandler(backend, { cursor: "not-a-cursor" }),
    ).rejects.toThrow("Invalid cursor");
  });

  it("returns text and structured content by default", async () => {
    const result = await listTodosHandler(backend, { status: "all" });
    const structured = structuredOf(result);

    expect(textsOf(result)).toHaveLength(5);
    expect(structured.total).toBe(5);
    expect(structured.nextCursor).toBeNull();
    expect(z.object(ListTodosOutputShape).parse(structured)).toEqual(structured);
  });

  it("returns only a one-line summary in structured format", async () => {
    const result = await listTodosHandler(backend, {
      status: "all",
      format: "structured",
    });
    const structured = structuredOf(result);

    expect(result.content[0].text).toBe("5 todos");
    expect(structured.todos).toHaveLength(5);
    expect(z.object(ListTodosOutputShape).parse(structured)).toEqual(structured);
  });

  it("returns only the text block in text format", async () => {
    const result = await listTodosHandler(backend, {
      status: "all",
      format: "text",
    });

    expect("structuredContent" in result).toBe(false);
    expect(textsOf(result)).toHaveLength(5);
  });
});
