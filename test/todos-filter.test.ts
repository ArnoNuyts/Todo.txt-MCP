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

  it("omits hidden and future-threshold todos from the 'done' view", () => {
    freezeToday();
    const todos = [
      new Todo("x 2026-01-01 Done visible"),
      new Todo("x 2026-01-01 Done hidden h:1"),
      new Todo("x 2026-01-01 Done future t:2027-05-01"),
    ];

    expect(texts(filterTodos(todos, { status: "done" }))).toEqual([
      "Done visible",
    ]);
  });

  it("treats any non-zero h: value as hidden, regardless of order", () => {
    expect(texts(filterTodos([new Todo("First h:0 h:1")]))).toEqual([]);
    expect(texts(filterTodos([new Todo("Second h:1 h:0")]))).toEqual([]);
  });

  it("stays hidden across a serialization round-trip with duplicate h: tags", () => {
    const todo = new Todo("Task h:0 h:1");

    expect(texts(filterTodos([new Todo(todo.toString())]))).toEqual([]);
  });

  it("flips visibility at UTC midnight", () => {
    vi.useFakeTimers();
    const todos = [new Todo("Task t:2026-11-08")];

    vi.setSystemTime(new Date("2026-11-07T23:59:59.000Z"));
    expect(texts(filterTodos(todos))).toEqual([]);

    vi.setSystemTime(new Date("2026-11-08T00:00:00.000Z"));
    expect(texts(filterTodos(todos))).toEqual(["Task"]);
  });

  it("combines status 'all' with context and search filters", () => {
    freezeToday();
    const todos = [
      new Todo("Hidden home @home h:1"),
      new Todo("Future work @work t:2027-05-01"),
      new Todo("Visible home @home"),
    ];

    expect(texts(filterTodos(todos, { status: "all", context: "home" })))
      .toEqual(["Hidden home @home", "Visible home @home"]);
    expect(texts(filterTodos(todos, { status: "all", search: "future" })))
      .toEqual(["Future work @work"]);
  });
});
