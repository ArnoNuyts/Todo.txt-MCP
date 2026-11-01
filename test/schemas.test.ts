import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AddTodosSchema,
  AddTodoSchema,
  DeleteCompletedSchema,
  DeleteTodosSchema,
  DeleteTodoSchema,
  EditTodoSchema,
  ListTodosSchema,
  SetTodoStatusesSchema,
  SetTodoStatusSchema,
  UpdateTodosSchema,
} from "../server.ts";

function hasDescription(schema: z.ZodType): boolean {
  return schema.description !== undefined && schema.description !== null;
}

describe("Tool schemas", () => {
  it("should have descriptions for all properties", () => {
    const schemas = {
      add_todos: AddTodosSchema,
      add_todo: AddTodoSchema,
      update_todos: UpdateTodosSchema,
      edit_todo: EditTodoSchema,
      list_todos: ListTodosSchema,
      set_todo_statuses: SetTodoStatusesSchema,
      set_todo_status: SetTodoStatusSchema,
      delete_todos: DeleteTodosSchema,
      delete_todo: DeleteTodoSchema,
      delete_completed: DeleteCompletedSchema,
    };

    for (const [name, schema] of Object.entries(schemas)) {
      expect(schema).toBeInstanceOf(z.ZodObject);
      if (schema instanceof z.ZodObject) {
        for (
          const [propName, propSchema] of Object.entries(schema.shape)
        ) {
          expect(
            hasDescription(propSchema),
            `Property '${propName}' in schema '${name}' should have a description.`,
          ).toBe(true);

          if (propSchema instanceof z.ZodArray) {
            if (propSchema.element instanceof z.ZodObject) {
              for (
                const [key, value] of Object.entries(
                  propSchema.element.shape,
                ) as [string, z.ZodType][]
              ) {
                expect(
                  hasDescription(value),
                  `Property '${key}' in schema '${name}' should have a description.`,
                ).toBe(true);
              }
            }
          }
        }
      }
    }
  });

  it("should reject inputs outside the allowed bounds", () => {
    expect(() =>
      AddTodoSchema.parse({
        todos: Array.from({ length: 101 }, (_, i) => `todo ${i}`),
      })
    ).toThrow();
    expect(() => AddTodoSchema.parse({ todos: ["a".repeat(2001)] })).toThrow();
    expect(() =>
      EditTodoSchema.parse({
        edits: Array.from({ length: 101 }, () => ({
          hash: "0123456789abcdef",
          text: "text",
        })),
      })
    ).toThrow();
    expect(() =>
      EditTodoSchema.parse({
        edits: [{ hash: "0123456789abcdef", text: "a".repeat(2001) }],
      })
    ).toThrow();
    expect(() => ListTodosSchema.parse({ limit: 0 })).toThrow();
    expect(() => ListTodosSchema.parse({ limit: 501 })).toThrow();
    expect(() => ListTodosSchema.parse({ offset: -1 })).toThrow();
    expect(() => ListTodosSchema.parse({ search: "a".repeat(201) })).toThrow();
    expect(() => ListTodosSchema.parse({ limit: 1.5 })).toThrow();
    expect(() => ListTodosSchema.parse({ priority: "a" })).toThrow();
    expect(() => ListTodosSchema.parse({ priority: "AB" })).toThrow();
    expect(() => ListTodosSchema.parse({ dueBefore: "2026-02-30" })).toThrow();
    expect(() => ListTodosSchema.parse({ createdAfter: "02-01-2026" }))
      .toThrow();
    expect(() => ListTodosSchema.parse({ sort: "alphabetical" })).toThrow();
    expect(() => ListTodosSchema.parse({ format: "json" })).toThrow();
    expect(() => DeleteTodoSchema.parse({ hash: "short" })).toThrow();
    expect(() => DeleteTodoSchema.parse({ hash: "a".repeat(65) })).toThrow();
    expect(() =>
      AddTodosSchema.parse({
        todos: ["task"],
        idempotencyKey: "has whitespace",
      })
    ).toThrow();
    expect(() =>
      AddTodosSchema.parse({ todos: ["task"], onDuplicate: "ignore" })
    ).toThrow();
    expect(() =>
      DeleteTodosSchema.parse({
        hashes: Array.from({ length: 101 }, () => "0123456789abcdef"),
      })
    ).toThrow();
    expect(() => DeleteTodosSchema.parse({ hashes: [] })).toThrow();
    expect(() => DeleteTodosSchema.parse({ hashes: ["short"] })).toThrow();
    expect(() =>
      SetTodoStatusesSchema.parse({
        hashes: Array.from({ length: 101 }, () => "0123456789abcdef"),
        status: "done",
      })
    ).toThrow();
    expect(() => SetTodoStatusesSchema.parse({ hashes: [], status: "done" }))
      .toThrow();
    expect(() =>
      SetTodoStatusesSchema.parse({ hashes: ["01234567"], status: "other" })
    ).toThrow();
    expect(() => DeleteCompletedSchema.parse({ before: "2026-02-30" }))
      .toThrow();
    expect(() => DeleteCompletedSchema.parse({ before: "01-02-2026" }))
      .toThrow();
    expect(() => DeleteCompletedSchema.parse({ context: "" })).toThrow();
  });

  it("should accept inputs on the allowed bounds", () => {
    expect(() =>
      AddTodoSchema.parse({
        todos: Array.from({ length: 100 }, (_, i) => `todo ${i}`),
      })
    ).not.toThrow();
    expect(() => ListTodosSchema.parse({ limit: 1, offset: 0 })).not.toThrow();
    expect(() => ListTodosSchema.parse({ limit: 500 })).not.toThrow();
    expect(() =>
      ListTodosSchema.parse({
        context: "@home",
        project: "work",
        priority: "A",
        tag: { due: "2026-02-28" },
        dueBefore: "2026-03-01",
        createdAfter: "2026-01-01",
        sort: "priority",
        cursor: "b2Zmc2V0OjI",
        format: "text",
      })
    ).not.toThrow();
    expect(() => DeleteTodoSchema.parse({ hash: "01234567" })).not.toThrow();
    expect(() => DeleteTodoSchema.parse({ hash: "a".repeat(64) })).not.toThrow();
    expect(() =>
      AddTodosSchema.parse({
        todos: ["task"],
        idempotencyKey: "key-1:retry_2",
        onDuplicate: "skip",
      })
    ).not.toThrow();
    expect(() =>
      DeleteTodosSchema.parse({ hashes: ["0123456789abcdef"] })
    ).not.toThrow();
    expect(() =>
      SetTodoStatusesSchema.parse({
        hashes: ["0123456789abcdef"],
        status: "todo",
      })
    ).not.toThrow();
    expect(() =>
      DeleteCompletedSchema.parse({ before: "2026-02-28", context: "@home" })
    ).not.toThrow();
    expect(() => DeleteCompletedSchema.parse({})).not.toThrow();
  });
});
