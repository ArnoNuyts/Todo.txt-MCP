import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Todo } from "../logic/todo.ts";

const FIXED_NOW = new Date("2024-06-15T12:00:00.000Z");

function complete(line: string): {
  completed: Todo;
  next: Todo | undefined;
} {
  const completed = new Todo(line);
  return { completed, next: completed.toggleState().recurrence };
}

describe("recurrence threshold semantics", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const cases = [
    {
      name: "strict recurrence keeps a threshold before the due date",
      line: "task due:2024-06-20 t:2024-06-10 rec:+1w",
      due: "2024-06-27",
      threshold: "2024-06-17",
    },
    {
      name: "strict recurrence keeps a threshold after the due date",
      line: "task due:2024-06-20 t:2024-06-25 rec:+1w",
      due: "2024-06-27",
      threshold: "2024-07-02",
    },
    {
      name: "strict recurrence keeps a threshold equal to the due date",
      line: "task due:2024-06-20 t:2024-06-20 rec:+2w",
      due: "2024-07-04",
      threshold: "2024-07-04",
    },
    {
      name: "normal recurrence uses completion for due but keeps the original threshold offset",
      line: "task due:2024-06-01 t:2024-05-25 rec:1w",
      due: "2024-06-22",
      threshold: "2024-06-15",
    },
    {
      name: "normal recurrence ignores a future due date for the next due",
      line: "task due:2024-06-30 t:2024-06-23 rec:1w",
      due: "2024-06-22",
      threshold: "2024-06-15",
    },
    {
      name: "normal recurrence keeps an after-due threshold offset",
      line: "task due:2024-06-20 t:2024-06-25 rec:1w",
      due: "2024-06-22",
      threshold: "2024-06-27",
    },
    {
      name: "a threshold without a due date uses today as the reference due",
      line: "task t:2024-06-01 rec:1w",
      due: "2024-06-22",
      threshold: "2024-06-08",
    },
    {
      name: "a threshold offset is calendar days, not months",
      line: "task due:2024-06-30 t:2024-06-20 rec:+1m",
      due: "2024-07-30",
      threshold: "2024-07-20",
    },
    {
      name: "a threshold offset survives a yearly recurrence",
      line: "task due:2024-06-15 t:2024-06-01 rec:+1y",
      due: "2025-06-15",
      threshold: "2025-06-01",
    },
  ] as const;

  for (const testCase of cases) {
    it(testCase.name, () => {
      const { next } = complete(testCase.line);

      expect(next?.tags.due).toBe(testCase.due);
      expect(next?.tags.t).toBe(testCase.threshold);
    });
  }

  it("does not mutate the completed todo's threshold", () => {
    const { completed, next } = complete(
      "task due:2024-06-20 t:2024-06-10 rec:+1w",
    );

    expect(completed.tags.t).toBe("2024-06-10");
    expect(next?.tags.t).toBe("2024-06-17");
  });

  it("does not add a threshold when the completed todo has none", () => {
    const { next } = complete("task due:2024-06-20 rec:+1w");

    expect(next?.tags.t).toBeUndefined();
  });

  it("preserves an invalid threshold tag instead of silently dropping it", () => {
    const { next } = complete(
      "task due:2024-06-20 t:not-a-date rec:+1w",
    );

    expect(next?.tags.due).toBe("2024-06-27");
    expect(next?.tags.t).toBe("not-a-date");
  });
});
