import { describe, expect, it } from "vitest";
import { parseTodoHeader } from "../logic/todo-date-header.ts";

describe("todo date header", () => {
  it("parses a done todo's completion and creation dates", () => {
    const parsed = parseTodoHeader("x 2024-02-01 2024-01-01 task");

    expect(parsed?.done).toBe(true);
    expect(parsed?.header.completionDate?.toISOString()).toBe(
      "2024-02-01T00:00:00.000Z",
    );
    expect(parsed?.header.creationDate?.toISOString()).toBe(
      "2024-01-01T00:00:00.000Z",
    );
    expect(parsed?.header.issues).toEqual({
      invalidTokens: [],
      ambiguous: false,
    });
    expect(parsed?.rest).toBe("task");
  });

  it("uses the first leading date as an open todo's creation date", () => {
    const parsed = parseTodoHeader("2024-01-01 task");

    expect(parsed?.done).toBe(false);
    expect(parsed?.header.creationDate?.toISOString()).toBe(
      "2024-01-01T00:00:00.000Z",
    );
    expect(parsed?.header.completionDate).toBeUndefined();
  });

  it("keeps an impossible date as literal text and reports it", () => {
    const parsed = parseTodoHeader("2024-13-01 task");

    expect(parsed?.header.completionDate).toBeUndefined();
    expect(parsed?.header.creationDate).toBeUndefined();
    expect(parsed?.header.literalPrefix).toBe("2024-13-01 ");
    expect(parsed?.header.issues.invalidTokens).toEqual(["2024-13-01"]);
    expect(parsed?.header.issues.ambiguous).toBe(false);
    expect(parsed?.rest).toBe("task");
  });

  it("keeps a valid completion date when the creation token is impossible", () => {
    const parsed = parseTodoHeader("x 2024-01-01 2024-13-01 task");

    expect(parsed?.header.completionDate?.toISOString()).toBe(
      "2024-01-01T00:00:00.000Z",
    );
    expect(parsed?.header.creationDate).toBeUndefined();
    expect(parsed?.header.literalPrefix).toBe("2024-01-01 2024-13-01 ");
  });

  it("drops both dates when both leading tokens are impossible", () => {
    const parsed = parseTodoHeader("2024-13-01 2024-02-30 task");

    expect(parsed?.header.completionDate).toBeUndefined();
    expect(parsed?.header.creationDate).toBeUndefined();
    expect(parsed?.header.issues.invalidTokens).toEqual([
      "2024-13-01",
      "2024-02-30",
    ]);
  });

  it("marks an open todo with two date tokens as ambiguous", () => {
    expect(
      parseTodoHeader("2024-01-01 2024-02-02 task")?.header.issues.ambiguous,
    ).toBe(true);
    expect(
      parseTodoHeader("2024-13-01 2024-01-01 task")?.header.issues.ambiguous,
    ).toBe(true);
    expect(
      parseTodoHeader("x 2024-01-01 2024-02-02 task")?.header.issues.ambiguous,
    ).toBe(false);
  });

  it("keeps a valid date when the other leading token is impossible", () => {
    const parsed = parseTodoHeader("2024-13-01 2024-01-01 task");

    expect(parsed?.header.completionDate).toBeUndefined();
    expect(parsed?.header.creationDate?.toISOString()).toBe(
      "2024-01-01T00:00:00.000Z",
    );
    expect(parsed?.header.literalPrefix).toBe("2024-13-01 2024-01-01 ");
    expect(parsed?.header.issues.invalidTokens).toEqual(["2024-13-01"]);
    expect(parsed?.rest).toBe("task");
  });

  it("keeps a valid creation date on a done line with an impossible completion date", () => {
    const parsed = parseTodoHeader("x 2024-13-01 2024-01-01 task");

    expect(parsed?.header.completionDate).toBeUndefined();
    expect(parsed?.header.creationDate?.toISOString()).toBe(
      "2024-01-01T00:00:00.000Z",
    );
    expect(parsed?.header.literalPrefix).toBe("2024-13-01 2024-01-01 ");
  });

  it("parses done and priority prefixes", () => {
    const parsed = parseTodoHeader("x (A) 2024-02-01 task");

    expect(parsed).toMatchObject({ done: true, priority: "A", rest: "task" });
  });

  it("treats a headerless line as plain rest text", () => {
    expect(parseTodoHeader("just text")).toMatchObject({
      done: false,
      header: {
        completionDate: undefined,
        creationDate: undefined,
        literalPrefix: "",
      },
      rest: "just text",
    });
    expect(parseTodoHeader("")).toBeUndefined();
  });
});
