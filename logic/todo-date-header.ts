import type { UpperCaseLetter } from "../types/types.ts";
import { parseDateTag } from "./recurrence.ts";

/**
 * Leading date/priority header of one todo.txt line. Keeping this parsing in
 * one value object prevents `Todo` (and its validators) from re-deciding which
 * tokens are structured dates, literal text, or ambiguous.
 */

const TODO_REGEX =
  /^((?<done>[x])\s){0,1}(\((?<prio>[A-Z])\)\s){0,1}((?<completionDate>\d{4}-[0-1][0-9]-[0-3][0-9])\s){0,1}((?<creationDate>\d{4}-[0-1][0-9]-[0-3][0-9])\s){0,1}(?<rest>[^\n\r]+)\s*$/;

export interface TodoDateIssues {
  /** Tokens that looked like dates but are not real calendar dates. */
  readonly invalidTokens: readonly string[];
  /** True for an open todo with two leading date tokens. */
  readonly ambiguous: boolean;
}

interface TodoDateHeader {
  /** `x <completionDate> <creationDate> ...` when the todo is done. */
  completionDate?: Date;
  /**
   * A leading date that parsed successfully. For an open todo it is normally
   * the last token; for a done todo it is the second token when valid. In a
   * mixed line the surviving valid token may be the first.
   */
  creationDate?: Date;
  /** Raw tokens to emit when an invalid date prevents structured parsing. */
  literalPrefix: string;
  issues: TodoDateIssues;
}

export interface ParsedTodoHeader {
  done: boolean;
  priority?: UpperCaseLetter;
  header: TodoDateHeader;
  rest: string;
}

/** Parses the leading `x`, priority, and date tokens of a todo line. */
export function parseTodoHeader(text: string): ParsedTodoHeader | undefined {
  const match = text.match(TODO_REGEX);
  if (match?.groups === undefined) {
    return undefined;
  }

  const { done, prio, completionDate, creationDate, rest } = match.groups;
  const isDone = done !== undefined;
  const completion = completionDate === undefined
    ? undefined
    : parseDateTag(completionDate);
  const creation = creationDate === undefined
    ? undefined
    : parseDateTag(creationDate);
  const hasTwoTokens = completionDate !== undefined &&
    creationDate !== undefined;

  const invalidTokens: string[] = [];
  if (completionDate !== undefined && completion === undefined) {
    invalidTokens.push(completionDate);
  }
  if (creationDate !== undefined && creation === undefined) {
    invalidTokens.push(creationDate);
  }

  if (invalidTokens.length > 0) {
    const literalPrefix = [completionDate, creationDate]
      .filter((token): token is string => token !== undefined)
      .map((token) => `${token} `)
      .join("");
    return {
      done: isDone,
      priority: prio as UpperCaseLetter | undefined,
      header: {
        // Keep the date that did parse so consumers can still observe it. The
        // literal prefix stays the source of truth for serialization, so the
        // invalid token is never silently dropped or rewritten.
        completionDate: isDone ? completion : undefined,
        creationDate: isDone ? creation : creation ?? completion,
        literalPrefix,
        issues: {
          invalidTokens,
          ambiguous: !isDone && hasTwoTokens,
        },
      },
      rest: rest as string,
    };
  }

  if (isDone) {
    return {
      done: true,
      priority: prio as UpperCaseLetter | undefined,
      header: {
        completionDate: completion,
        creationDate: creation,
        literalPrefix: "",
        issues: { invalidTokens: [], ambiguous: false },
      },
      rest: rest as string,
    };
  }

  return {
    done: false,
    priority: prio as UpperCaseLetter | undefined,
    header: {
      completionDate: undefined,
      // An open todo has no completion date; a lone date is its creation date.
      creationDate: creation ?? completion,
      literalPrefix: "",
      issues: { invalidTokens: [], ambiguous: hasTwoTokens },
    },
    rest: rest as string,
  };
}
