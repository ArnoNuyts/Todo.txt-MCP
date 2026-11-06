import { describe, expect, it } from "vitest";
import { contextTokenPattern } from "../logic/tokens.ts";

describe("context token pattern", () => {
  it("matches a context at the start, middle, or end", () => {
    const pattern = contextTokenPattern("home");

    expect(pattern.test("@home Task")).toBe(true);
    expect(pattern.test("Task @home")).toBe(true);
    expect(pattern.test("Task @home done")).toBe(true);
  });

  it("does not match a longer context", () => {
    const pattern = contextTokenPattern("home");

    expect(pattern.test("@homework")).toBe(false);
    expect(pattern.test("Task @homework")).toBe(false);
  });

  it("matches context names with regex-special characters", () => {
    const pattern = contextTokenPattern("a.b");

    expect(pattern.test("Task @a.b")).toBe(true);
    expect(pattern.test("Task @aXb")).toBe(false);
  });
});
