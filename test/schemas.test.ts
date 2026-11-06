import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CompactAddTodosSchema,
  CompactListTodosSchema,
  CompactDeleteTodosSchema,
  CompactUpdateTodosSchema,
} from "../logic/tools.ts";

function hasDescription(schema: z.ZodType): boolean {
  return schema.description !== undefined && schema.description !== null;
}

describe("tool schemas", () => {
  it("describes every property", () => {
    const schemas = {
      list_todos: CompactListTodosSchema,
      add_todos: CompactAddTodosSchema,
      update_todos: CompactUpdateTodosSchema,
      delete_todos: CompactDeleteTodosSchema,
    };

    for (const [name, schema] of Object.entries(schemas)) {
      expect(schema).toBeInstanceOf(z.ZodObject);
      if (schema instanceof z.ZodObject) {
        for (const [propName, propSchema] of Object.entries(schema.shape)) {
          expect(
            hasDescription(propSchema),
            `Property '${propName}' in '${name}' should have a description.`,
          ).toBe(true);
        }
      }
    }
  });

  it("rejects inputs outside the allowed bounds", () => {
    expect(() => CompactListTodosSchema.parse({ limit: 0 })).toThrow();
    expect(() => CompactListTodosSchema.parse({ limit: 101 })).toThrow();
    expect(() => CompactListTodosSchema.parse({ offset: -1 })).toThrow();
    expect(() => CompactListTodosSchema.parse({ offset: 0 })).not.toThrow();
    expect(() => CompactAddTodosSchema.parse({ todos: [] })).toThrow();
    expect(() =>
      CompactAddTodosSchema.parse({
        todos: Array.from({ length: 101 }, (_, i) => `todo ${i}`),
      })
    ).toThrow();
    expect(() => CompactDeleteTodosSchema.parse({ hashes: [] })).toThrow();
    expect(() => CompactUpdateTodosSchema.parse({ updates: [] })).toThrow();
    expect(() =>
      CompactUpdateTodosSchema.parse({ updates: ["x"] })
    ).toThrow();
    expect(() =>
      CompactUpdateTodosSchema.parse({
        updates: ["01234567 (A) Task @home"],
      })
    ).not.toThrow();
    expect(() =>
      CompactUpdateTodosSchema.parse({
        updates: Array.from({ length: 101 }, (_, i) => `01234567 todo ${i}`),
      })
    ).toThrow();
  });
});
