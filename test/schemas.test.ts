import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AddTodoSchema,
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
    };

    for (const [name, schema] of Object.entries(schemas)) {
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
});
