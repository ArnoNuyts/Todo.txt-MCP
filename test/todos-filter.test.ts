import { afterEach, describe, expect, it, vi } from "vitest";
import { filterTodos } from "../logic/Todos.ts";
import { Todo } from "../logic/todo.ts";

const texts = (todos: readonly Todo[]) => todos.map((todo) => todo.text);

describe("filterTodos visibility", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function freezeToday() {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T12:00:00.000Z"));
  }

  it("omits todos whose threshold date is in the future", () => {
    freezeToday();
    const todos = [
      new Todo("Visible task"),
      new Todo("Future task t:2027-05-01"),
    ];

    expect(texts(filterTodos(todos))).toEqual(["Visible task"]);
  });

  it("keeps todos whose threshold date is today or in the past", () => {
    freezeToday();
    const todos = [
      new Todo("Today task t:2026-11-07"),
      new Todo("Past task t:2020-01-01"),
    ];

    expect(texts(filterTodos(todos))).toEqual(["Today task", "Past task"]);
  });

  it("keeps todos with an invalid threshold date", () => {
    freezeToday();
    const todos = [new Todo("Broken task t:not-a-date")];

    expect(texts(filterTodos(todos))).toEqual(["Broken task"]);
  });

  it("omits todos marked hidden", () => {
    const todos = [
      new Todo("Visible task"),
      new Todo("Hidden task h:1"),
    ];

    expect(texts(filterTodos(todos))).toEqual(["Visible task"]);
  });

  it("keeps todos explicitly marked as not hidden", () => {
    const todos = [new Todo("Shown task h:0")];

    expect(texts(filterTodos(todos))).toEqual(["Shown task"]);
  });

  it("includes hidden and future-threshold todos for status 'all'", () => {
    freezeToday();
    const todos = [
      new Todo("Visible task"),
      new Todo("Hidden task h:1"),
      new Todo("Future task t:2027-05-01"),
    ];

    expect(texts(filterTodos(todos, { status: "all" }))).toEqual([
      "Visible task",
      "Hidden task",
      "Future task",
    ]);
  });
});
