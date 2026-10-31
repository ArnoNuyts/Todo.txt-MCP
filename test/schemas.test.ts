import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AddTodoSchema,
  DeleteTodoSchema,
  EditTodoSchema,
  ListTodosSchema,
  SetTodoStatusSchema,
} from "../server.ts";

function hasDescription(schema: z.ZodType): boolean {
  return schema.description !== undefined && schema.description !== null;
}

describe("Tool schemas", () => {
  it("should have descriptions for all properties", () => {
    const schemas = {
      add_todo: AddTodoSchema,
      edit_todo: EditTodoSchema,
      list_todos: ListTodosSchema,
      set_todo_status: SetTodoStatusSchema,
      delete_todo: DeleteTodoSchema,
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
    expect(() => DeleteTodoSchema.parse({ hash: "short" })).toThrow();
    expect(() => DeleteTodoSchema.parse({ hash: "a".repeat(65) })).toThrow();
  });

  it("should accept inputs on the allowed bounds", () => {
    expect(() =>
      AddTodoSchema.parse({
        todos: Array.from({ length: 100 }, (_, i) => `todo ${i}`),
      })
    ).not.toThrow();
    expect(() => ListTodosSchema.parse({ limit: 1, offset: 0 })).not.toThrow();
    expect(() => ListTodosSchema.parse({ limit: 500 })).not.toThrow();
    expect(() => DeleteTodoSchema.parse({ hash: "01234567" })).not.toThrow();
    expect(() => DeleteTodoSchema.parse({ hash: "a".repeat(64) })).not.toThrow();
  });
});
