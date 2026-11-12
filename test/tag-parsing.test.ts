import { describe, expect, it } from "vitest";
import { Todo } from "../logic/todo.ts";

function valuesOf(tag: string | string[] | undefined): string[] {
  return Array.isArray(tag) ? tag : tag === undefined ? [] : [tag];
}

describe("tag parsing", () => {
  it("parses 60,000 distinct values on one key in linear time", () => {
    const count = 60_000;
    const values = Array.from({ length: count }, (_, index) => `v${index}`);
    // Repeat a couple of values at the end to prove dedupe still holds at scale.
    const body = `bulk ${values.map((value) => `k:${value}`).join(" ")} ` +
      "k:v0 k:v59999";

    const started = performance.now();
    const todo = new Todo(body);
    const elapsed = performance.now() - started;

    const parsed = valuesOf(todo.tags.k);
    expect(parsed).toHaveLength(count);
    expect(parsed[0]).toBe("v0");
    expect(parsed[1]).toBe("v1");
    expect(parsed[5]).toBe("v5");
    expect(parsed[count - 1]).toBe("v59999");
    expect(new Set(parsed).size).toBe(count);
    expect(todo.text).toBe("bulk");
    // Generous guard: quadratic parsing took tens of seconds for this input.
    expect(elapsed).toBeLessThan(5_000);
  }, 20_000);

  it("dedupes values per key and keeps first-seen order", () => {
    const todo = new Todo("task alpha:1 beta:2 alpha:3 beta:2 alpha:1");

    expect(todo.tags).toEqual({ alpha: ["1", "3"], beta: "2" });
    expect(todo.text).toBe("task");
  });

  it("dedupes duplicate identical tags", () => {
    const todo = new Todo("task due:2026-12-15 due:2026-12-15");

    expect(todo.tags.due).toBe("2026-12-15");
    expect(todo.text).toBe("task");
  });

  it("keeps projects and contexts outside the tag removal", () => {
    const todo = new Todo(
      "task +proj @ctx due:2026-12-15 @other +other tag:a",
    );

    expect(todo.text).toBe("task +proj @ctx @other +other");
    expect(Array.from(todo.projects)).toEqual(["proj", "other"]);
    expect(Array.from(todo.contexts)).toEqual(["ctx", "other"]);
    expect(todo.tags).toEqual({ due: "2026-12-15", tag: "a" });
  });

  it("preserves the previous whitespace behavior when stripping tags", () => {
    const cases = [
      { input: "task due:2026-12-15   tail", expected: "task   tail" },
      { input: "  due:2026-12-15 task", expected: " task" },
      { input: "task   due:2026-12-15", expected: "task" },
      {
        input: "task  due:2026-12-15   due:2026-12-16  end",
        expected: "task  end",
      },
      { input: "task due:2026-12-15    ", expected: "task    " },
      { input: "task\tdue:2026-12-15\ttail", expected: "task\ttail" },
    ];

    for (const { input, expected } of cases) {
      expect(new Todo(input).text, `Input "${input}"`).toBe(expected);
    }
  });

  it("appends and dedupes across repeated setText calls", () => {
    const todo = new Todo("first due:2026-12-15 tag:a +old @old");

    todo.setText("second due:2026-12-15 tag:b due:2026-12-16 +new @new");

    expect(todo.tags).toEqual({
      due: ["2026-12-15", "2026-12-16"],
      tag: ["a", "b"],
    });
    expect(todo.text).toBe("second +new @new");
    expect(Array.from(todo.projects)).toEqual(["new"]);
    expect(Array.from(todo.contexts)).toEqual(["new"]);

    todo.setText("second due:2026-12-15 tag:b +new @new");

    expect(todo.tags).toEqual({
      due: ["2026-12-15", "2026-12-16"],
      tag: ["a", "b"],
    });
    expect(todo.text).toBe("second +new @new");
  });

  it("keeps tags when a later setText body has none", () => {
    const todo = new Todo("first due:2026-12-15");

    todo.setText("plain replacement");

    expect(todo.tags).toEqual({ due: "2026-12-15" });
    expect(todo.text).toBe("plain replacement");
  });

  it("round-trips a loaded line and keeps its hash stable", async () => {
    const raw =
      "2024-06-02 Task   due:2026-12-15   rec:1w tag:a tag:b +proj @ctx  ";
    const todo = new Todo(raw);

    expect(todo.toString()).toBe(raw);
    const firstHash = await todo.getHash();
    expect(await todo.getHash()).toBe(firstHash);
    expect(await new Todo(raw).getHash()).toBe(firstHash);
    expect(todo.toDisplayString()).toBe(
      "Task +proj @ctx   due:2026-12-15 rec:1w tag:a tag:b",
    );
  });

  it("parses roughly 400 tags on a 2,000-char line quickly", () => {
    const tags = Array.from({ length: 400 }, (_, index) => `k:${index % 100}`);
    const body = `task ${tags.join(" ")}`;
    expect(body.length).toBeLessThan(2_200);

    const started = performance.now();
    const todo = new Todo(body);
    const elapsed = performance.now() - started;

    const parsed = valuesOf(todo.tags.k);
    expect(parsed).toHaveLength(100);
    expect(parsed[0]).toBe("0");
    expect(parsed[99]).toBe("99");
    expect(todo.text).toBe("task");
    expect(elapsed).toBeLessThan(1_000);
  });
});
