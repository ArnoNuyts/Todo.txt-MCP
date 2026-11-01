import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Todo } from "../logic/todo.ts"; // Adjust the path as needed
import { TodoStateEnum } from "../types/enums.ts";
import type { UpperCaseLetter } from "../types/types.ts";

const FIXED_NOW = new Date("2024-06-15T12:00:00.000Z");

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

const addDays = (d: Date, days: number) => {
  const result = new Date(d);
  result.setDate(result.getDate() + days);
  return result;
};

describe("Todo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("Todo constructor - sets text correctly", () => {
    const testCases = [
      { input: "x Completed", expected: "Completed" },
      { input: "(B) With prio", expected: "With prio" },
      { input: "x (A) Completed with prio", expected: "Completed with prio" },
      { input: "todo", expected: "todo" },
      { input: "with @context", expected: "with @context" },
      { input: "with @multiple @context", expected: "with @multiple @context" },
      { input: "with +project", expected: "with +project" },
      { input: "with +multiple +project", expected: "with +multiple +project" },
      { input: "with +multiple +project", expected: "with +multiple +project" },
      { input: "2024-06-02 With creation date", expected: "With creation date" },
      { input: "With tags:yeah", expected: "With" },
      {
        input: "x 2024-06-02 2024-06-02 With complition and creation date",
        expected: "With complition and creation date",
      },
      {
        input: "x    excessive space before",
        expected: "   excessive space before",
      }, // Should this be trimmed?
      {
        input: "x excessive space after    ",
        expected: "excessive space after    ",
      }, // Should this be trimmed?
    ];

    for (const { input, expected } of testCases) {
      const todo = new Todo(input);

      expect(
        todo.text,
        `Input "${input}" should have exactly the text: ${expected}`,
      ).toBe(expected);
    }
  });

  it("Todo constructor - sets state correctly", () => {
    const testCases = [
      { input: "todo", expected: TodoStateEnum.todo },
      { input: "x Completed", expected: TodoStateEnum.done },
      { input: "(B) Todo", expected: TodoStateEnum.todo },
      { input: "x (A) Completed", expected: TodoStateEnum.done },
    ];

    for (const { input, expected } of testCases) {
      const todo = new Todo(input);

      expect(
        todo.state,
        `Input "${input}" should have exactly the state: ${expected}`,
      ).toBe(expected);
    }
  });

  it("Todo constructor - sets priority correctly", () => {
    const testCases = [
      { input: "x (A) Completed", expected: "A" },
      { input: "(B) Todo", expected: "B" },
      { input: "(C) 2024-06-02 Todo", expected: "C" },
      { input: "2024-06-02 Todo", expected: undefined },
      { input: "x Completed", expected: undefined },
      { input: "todo", expected: undefined },
    ];

    for (const { input, expected } of testCases) {
      const todo = new Todo(input);

      expect(
        todo.priority,
        `Input "${input}" should have exactly the priority: ${expected}`,
      ).toBe(expected);
    }
  });

  it("Todo constructor - sets completionDate correctly", () => {
    const testCases = [
      {
        input: "x 2024-06-02 2024-06-01 Happy path",
        expected: new Date("2024-06-02T00:00:00.000Z"),
      },
      {
        input: "x 2024-06-02 Only completion date",
        expected: new Date("2024-06-02T00:00:00.000Z"),
      },
      {
        input: "2024-06-02 No completion date, not completed",
        expected: undefined,
      },
    ];

    for (const { input, expected } of testCases) {
      const todo = new Todo(input);

      expect(
        todo.completionDate,
        `Input "${input}" should have exactly the date: ${expected?.toISOString()}`,
      ).toEqual(expected);
    }
  });

  // Test for `completionDate`
  it("Todo constructor - sets completionDate correctly (additional cases)", () => {
    const testCases = [
      {
        input: "x 2024-06-02 2024-06-01 Buy groceries",
        expected: new Date("2024-06-02T00:00:00.000Z"),
      },
      {
        input: "x 2024-06-02 Buy groceries",
        expected: new Date("2024-06-02T00:00:00.000Z"),
      },
    ];

    for (const { input, expected } of testCases) {
      const todo = new Todo(input);

      expect(
        todo.completionDate,
        `Input "${input}" should have exactly the date: ${expected?.toISOString()}`,
      ).toEqual(expected);
    }
  });

  it("Todo constructor - treats a lone date on a done todo as its completion date", () => {
    const input = "x 2024-06-01 Buy groceries";
    const todo = new Todo(input);
    expect(todo.completionDate?.toISOString()).toBe(
      "2024-06-01T00:00:00.000Z",
    );
    expect(todo.creationDate).toBe(undefined);
  });

  // Test for `creationDate`
  it("Todo constructor - sets creationDate correctly", () => {
    const input = "2024-06-01 Buy groceries";
    const todo = new Todo(input);
    expect(todo.creationDate?.toISOString()).toBe("2024-06-01T00:00:00.000Z");
  });

  // Test for `projects` extraction
  it("Todo constructor - extracts projects correctly", () => {
    const testCases = [
      { input: "Buy groceries @home", expected: ["home"] },
      { input: "Fix the car @garage @tools", expected: ["garage", "tools"] },
      { input: "Read book", expected: [] }, // No contexts
      { input: "Add important feature @v0.1", expected: ["v0.1"] },
      { input: "Something with a @dash-of-salt", expected: ["dash-of-salt"] },
      { input: "Todo @snake_case", expected: ["snake_case"] },
      { input: "Todo @camelCase", expected: ["camelCase"] },
      { input: "Todo @StartWithUppercase", expected: ["StartWithUppercase"] },
    ];

    for (const { input, expected } of testCases) {
      const todo = new Todo(input);

      expect(
        Array.from(todo.contexts),
        `Input "${input}" should have exactly the contexts: ${
          expected.join(", ")
        }`,
      ).toEqual(expected);
    }
  });

  // Test for `contexts` extraction
  it("Todo constructor - extracts contexts correctly", () => {
    const testCases = [
      { input: "Buy groceries +home", expected: ["home"] },
      { input: "Fix the car +garage +tools", expected: ["garage", "tools"] },
      { input: "No contexts", expected: [] },
      { input: "Add important feature +v0.1", expected: ["v0.1"] },
      { input: "Something with a +dash-of-salt", expected: ["dash-of-salt"] },
      { input: "Todo +snake_case", expected: ["snake_case"] },
      { input: "Todo +camelCase", expected: ["camelCase"] },
      { input: "Todo +StartWithUppercase", expected: ["StartWithUppercase"] },
    ];

    for (const { input, expected } of testCases) {
      const todo = new Todo(input);

      expect(
        Array.from(todo.projects),
        `Input "${input}" should have exactly the contexts: ${
          expected.join(", ")
        }`,
      ).toEqual(expected);
    }
  });

  // Test for `tags` extraction
  it("Todo constructor - extracts tags correctly", () => {
    const testCases = [
      { input: "Todo h:1", expected: { h: "1" } },
      { input: "Todo due:2024-01-01", expected: { due: "2024-01-01" } },
      { input: "Todo t:2024-01-01", expected: { t: "2024-01-01" } },
      {
        input: "Todo multiple:t1 tags:t2",
        expected: { multiple: "t1", tags: "t2" },
      },
      {
        input: "Array of tags tag:one tag:two",
        expected: { tag: ["one", "two"] },
      },
      {
        input: "Array of tags tag:one tag:two tag:three",
        expected: { tag: ["one", "two", "three"] },
      },
    ];

    for (const { input, expected } of testCases) {
      const todo = new Todo(input);

      expect(
        todo.tags,
        `Input "${input}" should have exactly the tags: ${
          JSON.stringify(expected)
        }`,
      ).toEqual(expected);
    }
  });

  it("isDone - returns correctly", () => {
    const testCases = [
      { input: "x Done", expected: true },
      { input: "Todo", expected: false },
    ];

    for (const { input, expected } of testCases) {
      const todo = new Todo(input);

      expect(todo.isDone()).toBe(expected);
    }
  });

  it("isHidden - returns correctly", () => {
    const testCases = [
      { input: "Hidden h:1", expected: true },
      { input: "Hidden h:2", expected: true },
      { input: "Visible", expected: false },
      { input: "Visible h:0", expected: false },
    ];

    for (const { input, expected } of testCases) {
      const todo = new Todo(input);

      expect(todo.isHidden(), input).toBe(expected);
    }
  });

  it("isOverdue - returns correctly", () => {
    const testCases = [
      { input: "In the past due:1999-01-01", expected: true },
      { input: "In the future due:3000-01-01", expected: false },
      {
        input: `Today due:${isoDate(FIXED_NOW)}`,
        expected: false,
      },
      {
        input: `Tomorrow due:${isoDate(addDays(FIXED_NOW, 1))}`,
        expected: false,
      },
      {
        input: `Yesterday due:${isoDate(addDays(FIXED_NOW, -1))}`,
        expected: true,
      },
      { input: "No due date", expected: false },
    ];

    for (const { input, expected } of testCases) {
      const todo = new Todo(input);

      expect(todo.isOverdue(), input).toBe(expected);
    }
  });

  it("isPassedThreshold - returns correctly", () => {
    const testCases = [
      { input: "In the past t:1999-01-01", expected: true },
      { input: "In the future t:3000-01-01", expected: false },
      {
        input: `Today t:${isoDate(FIXED_NOW)}`,
        expected: true,
      },
      {
        input: `Tomorrow t:${isoDate(addDays(FIXED_NOW, 1))}`,
        expected: false,
      },
      {
        input: `Yesterday t:${isoDate(addDays(FIXED_NOW, -1))}`,
        expected: true,
      },
      { input: "No threshold date", expected: true },
    ];

    for (const { input, expected } of testCases) {
      const todo = new Todo(input);

      expect(todo.isPassedThreshold(), input).toBe(expected);
    }
  });

  it("toggleState - sets state correctly", () => {
    const testCases = [
      { input: "todo", expected: TodoStateEnum.done },
      { input: "x Completed", expected: TodoStateEnum.todo },
    ];

    for (const { input, expected } of testCases) {
      const todo = new Todo(input);
      todo.toggleState();

      expect(
        todo.state,
        `Input "${input}" should have exactly the state: ${expected}`,
      ).toBe(expected);
    }
  });

  it("toggleHidden - sets hidden correctly", () => {
    const testCases = [
      { input: "todo", expected: true },
      { input: "todo h:1", expected: false },
      { input: "todo h:0", expected: true },
      { input: "todo h:2", expected: false },
    ];

    for (const { input, expected } of testCases) {
      const todo = new Todo(input);
      todo.toggleHidden();

      expect(
        todo.isHidden(),
        `Input "${input}" should be: ${expected}`,
      ).toBe(expected);
    }
  });

  it("setPriority - sets priority correctly", () => {
    const testCases = [
      { text: "todo", input: "A" as UpperCaseLetter, expected: "A" },
      { text: "(A) todo", input: "A" as UpperCaseLetter, expected: "A" },
      { text: "(A) todo", input: "B" as UpperCaseLetter, expected: "B" },
    ];

    for (const { text, input, expected } of testCases) {
      const todo = new Todo(text);
      todo.setPriority(input);

      expect(
        todo.priority,
        `Input "${input}" should be: ${expected}`,
      ).toBe(expected);
    }
  });

  it("setDue - sets correctly", () => {
    const testCases = [
      { text: "todo", input: new Date("1999-01-01"), expected: "1999-01-01" },
      {
        text: "todo due:3000-03-03",
        input: new Date("1999-01-01"),
        expected: "1999-01-01",
      },
    ];

    for (const { text, input, expected } of testCases) {
      const todo = new Todo(text);
      todo.setDue(input);

      expect(
        todo.tags.due,
        `Input "${input}" should be: ${expected}`,
      ).toBe(expected);
    }
  });

  it("setThreshold - sets correctly", () => {
    const testCases = [
      { text: "todo", input: new Date("1999-01-01"), expected: "1999-01-01" },
      {
        text: "todo due:3000-03-03",
        input: new Date("1999-01-01"),
        expected: "1999-01-01",
      },
    ];

    for (const { text, input, expected } of testCases) {
      const todo = new Todo(text);
      todo.setThreshold(input);

      expect(
        todo.tags.t,
        `Input "${input}" should be: ${expected}`,
      ).toBe(expected);
    }
  });

  it("toString - should include creation date", () => {
    const todo = new Todo("2023-10-27 Test todo");
    expect(todo.toString().includes("2023-10-27")).toBe(true);
  });

  it("toDisplayString - should NOT include creation date", () => {
    const todo = new Todo("2023-10-27 Test todo");
    expect(todo.toDisplayString().includes("2023-10-27")).toBe(false);
  });

  describe("toString - date serialization round-trip", () => {
    const expectStableRoundTrip = (input: string) => {
      const first = new Todo(input);
      const serialized = first.toString();
      const second = new Todo(serialized);

      // Re-serializing the parsed todo must be byte-identical, otherwise every
      // save/load cycle changes the todo and its hash.
      expect(serialized, `Input "${input}" should serialize unchanged`).toBe(
        input,
      );
      expect(second.toString()).toBe(input);

      return second;
    };

    it("preserves completion and creation dates of a done todo", async () => {
      const todo = expectStableRoundTrip(
        "x 2024-06-02 2024-06-01 Buy groceries",
      );

      expect(todo.isDone()).toBe(true);
      expect(todo.completionDate?.toISOString()).toBe(
        "2024-06-02T00:00:00.000Z",
      );
      expect(todo.creationDate?.toISOString()).toBe(
        "2024-06-01T00:00:00.000Z",
      );
      expect(await todo.getHash()).toBe(
        await new Todo("x 2024-06-02 2024-06-01 Buy groceries").getHash(),
      );
    });

    it("preserves a done todo that only has a completion date", () => {
      const todo = expectStableRoundTrip("x 2024-06-02 Buy groceries");

      expect(todo.isDone()).toBe(true);
      expect(todo.completionDate?.toISOString()).toBe(
        "2024-06-02T00:00:00.000Z",
      );
      expect(todo.creationDate).toBe(undefined);
    });

    it("preserves an open todo that only has a creation date", () => {
      const todo = expectStableRoundTrip("2024-06-01 Buy groceries");

      expect(todo.isDone()).toBe(false);
      expect(todo.creationDate?.toISOString()).toBe(
        "2024-06-01T00:00:00.000Z",
      );
      expect(todo.completionDate).toBe(undefined);
    });

    it("preserves a todo without any dates", () => {
      const todo = expectStableRoundTrip("Buy groceries");

      expect(todo.creationDate).toBe(undefined);
      expect(todo.completionDate).toBe(undefined);
    });

    it("preserves priority, projects, contexts and tags", () => {
      const input =
        "x (A) 2024-06-02 2024-06-01 Buy groceries +home @errands due:2024-06-30 rec:1w";
      const todo = expectStableRoundTrip(input);

      expect(todo.isDone()).toBe(true);
      expect(todo.priority).toBe("A");
      expect(todo.text).toBe("Buy groceries +home @errands");
      expect(Array.from(todo.projects)).toEqual(["home"]);
      expect(Array.from(todo.contexts)).toEqual(["errands"]);
      expect(todo.tags).toEqual({ due: "2024-06-30", rec: "1w" });
    });

    it("toDisplayString shows the completion date, never the creation date", () => {
      const todo = new Todo("x 2024-06-02 2024-06-01 Buy groceries");

      expect(todo.toDisplayString()).toBe("x 2024-06-02 Buy groceries");
    });
  });

  it("getHash - returns 16 lowercase hex characters", async () => {
    const hash = await new Todo("Test todo").getHash();
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("getHash - should change when todo is modified", async () => {
    const todo = new Todo("Test todo");
    const oldHash = await todo.getHash();
    todo.setText("Updated todo");
    const newHash = await todo.getHash();
    expect(oldHash !== newHash).toBe(true);

    const todo2 = new Todo("Task to mark done");
    const hash2 = await todo2.getHash();
    todo2.toggleState();
    const hash2Done = await todo2.getHash();
    expect(hash2 !== hash2Done).toBe(true);
  });
});
