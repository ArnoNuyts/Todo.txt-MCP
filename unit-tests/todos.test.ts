import { assertEquals } from "https://deno.land/std@0.201.0/assert/mod.ts";
import { Todo } from "../logic/todo.ts"; // Adjust the path as needed
import { Todos } from "../logic/Todos.ts";

Deno.test("sortByImportance - should sort correctly", () => {
  const testCases = [
    {
      text: "Completion",
      todos: ["x 1", "2"],
      expected: ["2", "x 1"],
    },
    {
      text: "Prio",
      todos: ["(B) 1", "(A) 2"],
      expected: ["(A) 2", "(B) 1"],
    },
    {
      text: "Completion over prio",
      todos: ["x (A) 1", "(B) 2"],
      expected: ["(B) 2", "x (A) 1"],
    },
    {
      text: "Sort by @Context",
      todos: ["1 @B", "2 @A", "3 @A"],
      expected: ["2 @A", "3 @A", "1 @B"],
    },
    {
      text: "Sort by @Context undefined first",
      todos: ["1 @B", "2", "3 @A"],
      expected: ["2", "3 @A", "1 @B"],
    },
    {
      text: "Sort by @Context over prio",
      todos: ["(D) 1 @B", "(B) 2 @A", "(A) 3 @A"],
      expected: ["(A) 3 @A", "(B) 2 @A", "(D) 1 @B"],
    },
    {
      text: "Completion over @context",
      todos: ["(D) 1", "x (B) 2", "(A) 3"],
      expected: ["(A) 3", "(D) 1", "x (B) 2"],
    },
  ];

  for (const { todos, expected, text } of testCases) {
    const sorted = new Todos(...todos.map((x) => new Todo(x)))
      .sortByImportance();

    assertEquals(
      [...sorted].map((x) => x.toString()), // spreading get rid of Todos methods :/
      expected,
      text,
    );
  }
});

Deno.test("filterHidden - should hide correct todos", () => {
  const testCases = [
    {
      text: "Hidden",
      todos: ["x 1 h:1", "2"],
      expected: ["2"],
    },
    {
      text: "Threshold in the future",
      todos: ["1", "2 t:3000-01-01"],
      expected: ["1"],
    },
  ];

  for (const { todos, expected, text } of testCases) {
    const sorted = new Todos(...todos.map((x) => new Todo(x))).filterHidden();

    assertEquals(
      [...sorted].map((x) => x.toString()), // spreading get rid of Todos methods :/
      expected,
      text,
    );
  }
});

