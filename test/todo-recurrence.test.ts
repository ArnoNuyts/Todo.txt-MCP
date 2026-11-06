import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Todo } from "../logic/todo.ts";

const FIXED_NOW = new Date("2024-06-15T12:00:00.000Z");

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

const addDays = (d: Date, days: number) => {
  const result = new Date(d);
  result.setDate(result.getDate() + days);
  return result;
};

const addMonths = (d: Date, months: number) => {
  const result = new Date(d);
  result.setMonth(result.getMonth() + months);
  return result;
};

const addYears = (d: Date, years: number) => {
  const result = new Date(d);
  result.setFullYear(result.getFullYear() + years);
  return result;
};

describe("Todo recurrence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("toggleState - daily recurrence", () => {
    const todo = new Todo("todo rec:1d");
    const { recurrence: newTodo } = todo.toggleState();

    const tomorrow = addDays(FIXED_NOW, 1);

    expect(newTodo?.tags.due).toBe(isoDate(tomorrow));
  });

  it("toggleState - weekly recurrence", () => {
    const todo = new Todo("todo rec:1w");
    const { recurrence: newTodo } = todo.toggleState();

    const nextWeek = addDays(FIXED_NOW, 7);

    expect(newTodo?.tags.due).toBe(isoDate(nextWeek));
  });

  it("toggleState - monthly recurrence", () => {
    const todo = new Todo("todo rec:1m");
    const { recurrence: newTodo } = todo.toggleState();

    const nextMonth = addMonths(FIXED_NOW, 1);

    expect(newTodo!.tags.due).toBe(isoDate(nextMonth));
  });

  it("toggleState - yearly recurrence", () => {
    const todo = new Todo("todo rec:1y");
    const { recurrence: newTodo } = todo.toggleState();

    const nextYear = addYears(FIXED_NOW, 1);

    expect(newTodo?.tags.due).toBe(isoDate(nextYear));
  });

  it("normal recurrence advances from the completion date", () => {
    const todo = new Todo("todo due:2024-06-01 rec:1w");
    const { recurrence: newTodo } = todo.toggleState();

    expect(newTodo?.tags.due).toBe(isoDate(addDays(FIXED_NOW, 7)));
  });

  it("strict recurrence advances from the original due date", () => {
    const todo = new Todo("todo due:2024-06-01 rec:+1w");
    const { recurrence: newTodo } = todo.toggleState();

    expect(newTodo?.tags.due).toBe("2024-06-08");
  });

  it("strict recurrence without a due date starts from today", () => {
    const todo = new Todo("todo rec:+1w");
    const { recurrence: newTodo } = todo.toggleState();

    expect(newTodo?.tags.due).toBe(isoDate(addDays(FIXED_NOW, 7)));
  });

  it("moves the threshold by the original due-to-threshold offset", () => {
    const todo = new Todo("todo due:2024-06-20 t:2024-06-10 rec:+1w");
    const { recurrence: newTodo } = todo.toggleState();

    expect(newTodo?.tags.due).toBe("2024-06-27");
    expect(newTodo?.tags.t).toBe("2024-06-17");
  });

  it("updates the recurrence creation date", () => {
    const todo = new Todo("todo rec:1w");
    const { recurrence: newTodo } = todo.toggleState();

    expect(newTodo?.creationDate).toBeDefined();
    expect(isoDate(newTodo!.creationDate!)).toBe(isoDate(FIXED_NOW));
  });

  it("does not spawn a recurrence for a malformed rec tag", () => {
    const todo = new Todo("todo rec:fortnightly");
    const { recurrence } = todo.toggleState();

    expect(recurrence).toBeUndefined();
  });

  it("accepts uppercase recurrence units", () => {
    const todo = new Todo("todo due:2024-06-01 rec:+2W");
    const { recurrence: newTodo } = todo.toggleState();

    expect(newTodo?.tags.due).toBe("2024-06-15");
  });
});
