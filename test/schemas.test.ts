import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CompactAddTodosSchema,
  CompactListTodosSchema,
  CompactDeleteTodosSchema,
  CompactUpdateTodosSchema,
} from "../server.ts";

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
    expect(() =>
      CompactUpdateTodosSchema.parse({
        edits: [{ hash: "01234567" }],
      })
    ).not.toThrow();
    expect(() =>
      CompactUpdateTodosSchema.parse({
        edits: [{ hash: "01234567", priority: "a" }],
      })
    ).toThrow();
    expect(() =>
      CompactUpdateTodosSchema.parse({
        edits: [{ hash: "01234567", status: "other" }],
      })
    ).toThrow();
    expect(() =>
      CompactUpdateTodosSchema.parse({
        edits: [{
          hash: "01234567",
          threshold: "2026-12-01",
          recurrence: "+2w",
        }],
      })
    ).not.toThrow();
    expect(() =>
      CompactUpdateTodosSchema.parse({
        edits: [{ hash: "01234567", threshold: "12/01/2026" }],
      })
    ).toThrow();
    expect(() =>
      CompactUpdateTodosSchema.parse({
        edits: [{ hash: "01234567", recurrence: "weekly" }],
      })
    ).toThrow();
  });
});
