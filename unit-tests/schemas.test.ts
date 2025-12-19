import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { z } from "npm:zod@3.25.1";
import {
  AddTodoSchema,
  EditTodoSchema,
  ListTodosSchema,
  SetTodoStatusSchema,
} from "../server.ts";

function hasDescription(schema: z.ZodTypeAny): boolean {
  return schema._def.description !== undefined &&
    schema._def.description !== null;
}

Deno.test("Tool schemas should have descriptions for all properties", () => {
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
        assertEquals(
          hasDescription(propSchema),
          true,
          `Property '${propName}' in schema '${name}' should have a description.`,
        );

        if (propSchema instanceof z.ZodArray) {
          if (propSchema.element instanceof z.ZodObject) {
            for (
              const [key, value] of Object.entries(propSchema.element.shape) as [string, z.ZodTypeAny][]
            ) {
              assertEquals(
                hasDescription(value),
                true,
                `Property '${key}' in schema '${name}' should have a description.`,
              );
            }
          }
        }
      }
    }
  }
});
