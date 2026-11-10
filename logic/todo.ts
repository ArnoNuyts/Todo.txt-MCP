import { TodoStateEnum } from "../types/enums.ts";
import type { UpperCaseLetter } from "../types/types.ts";
import {
  nextRecurrence,
  parseDateTag,
  parseRecurrence,
  startOfUtcDay,
} from "./recurrence.ts";
import {
  parseTodoHeader,
  type TodoDateIssues,
} from "./todo-date-header.ts";
import {
  CONTEXT_REGEX,
  PROJECT_REGEX,
  TAG_REGEX,
} from "./tokens.ts";

const formatDate = (date: Date) => date.toISOString().substring(0, 10);

/**
 * Domain error for mutating a line whose two leading dates cannot be
 * canonicalised without dropping one. Callers should reject the write with
 * `INVALID_ARGUMENT` instead of guessing.
 */
export class AmbiguousTodoError extends Error {
  constructor() {
    super(
      "This todo starts with two dates; editing it would silently drop one. " +
        "Delete and re-add it instead.",
    );
    this.name = "AmbiguousTodoError";
  }
}

/**
 * Serializes tags, emitting a repeated `key:value` token for every value of a
 * multi-valued tag. `Array.toString()` would join them with a comma, which is
 * not a valid todo.txt tag separator and silently loses values.
 */
function serializeTags(tags: { [key: string]: string | string[] }): string {
  return Object.entries(tags)
    .flatMap(([key, value]) =>
      Array.isArray(value)
        ? value.map((item) => `${key}:${item}`)
        : [`${key}:${value}`]
    )
    .join(" ");
}

export class Todo {
  text: string = "";
  state: TodoStateEnum = TodoStateEnum.todo;
  completionDate: undefined | Date;
  creationDate: undefined | Date;
  priority: UpperCaseLetter | undefined; //  "A" | "B" | "C" | "D" | undefined;
  projects: Set<string> = new Set();
  contexts: Set<string> = new Set();
  tags: { [key: string]: string | string[] } = {};
  /**
   * The exact line this todo was parsed from. It is kept so a save can write
   * untouched todos back byte-for-byte instead of re-canonicalising tag order,
   * whitespace, or CRLF endings.
   */
  private originalLine: string | undefined;
  private originalSerialized: string | undefined;
  private dateIssues: TodoDateIssues = {
    invalidTokens: [],
    ambiguous: false,
  };

  /**
   * Leading date tokens that matched {@link parseTodoHeader} but are not real
   * calendar dates. Kept read-only for callers so parser bookkeeping cannot be
   * mutated from outside the class.
   */
  get invalidDateTokens(): readonly string[] {
    return this.dateIssues.invalidTokens;
  }

  /**
   * True when an open todo starts with two date tokens. Only one can be its
   * creation date, so editing such a line would silently drop a token; write
   * operations reject it instead.
   */
  get hasTwoLeadingDates(): boolean {
    return this.dateIssues.ambiguous;
  }

  constructor(text: string) {
    const originalLine = text;
    const parsed = parseTodoHeader(text);
    if (parsed !== undefined) {
      this.priority = parsed.priority;
      this.state = parsed.done
        ? TodoStateEnum.done
        : TodoStateEnum.todo;
      this.completionDate = parsed.header.completionDate;
      this.creationDate = parsed.header.creationDate;
      this.dateIssues = parsed.header.issues;
      text = parsed.header.literalPrefix + parsed.rest;
    }
    this.setText(text);
    this.originalLine = originalLine;
    try {
      this.originalSerialized = this.serialize();
    } catch {
      // Keep construction permissive for programmatic mutation; a loaded line
      // with malformed dates is handled above and never reaches this catch.
      this.originalSerialized = undefined;
    }
  }
  /** Toggles completion and returns a recurrence todo when one is spawned. */
  toggleState(completedAt: Date = new Date()): { recurrence?: Todo } {
    if (this.hasTwoLeadingDates) {
      throw new AmbiguousTodoError();
    }
    this.state = this.state === TodoStateEnum.todo
      ? TodoStateEnum.done
      : TodoStateEnum.todo;
    if (this.state === TodoStateEnum.done) {
      this.completionDate = completedAt;
    }
    if (this.state === TodoStateEnum.todo && this.completionDate) {
      this.completionDate = undefined;
    }

    if (this.state !== TodoStateEnum.done) {
      return {};
    }

    const recValue = Array.isArray(this.tags.rec)
      ? this.tags.rec[0]
      : this.tags.rec;
    const recurrence = recValue === undefined
      ? undefined
      : parseRecurrence(recValue);
    if (recurrence === undefined) {
      return {};
    }

    const next = nextRecurrence(
      recurrence,
      parseDateTag(this.tags.due),
      parseDateTag(this.tags.t),
      completedAt,
    );
    const newTodo = new Todo(this.toString());
    newTodo.state = TodoStateEnum.todo;
    newTodo.completionDate = undefined;
    newTodo.creationDate = startOfUtcDay(completedAt);
    newTodo.setDue(next.due);
    if (next.threshold !== undefined) {
      newTodo.setThreshold(next.threshold);
    }
    // An invalid t: tag cannot be shifted; the clone keeps it so no data is lost.
    return { recurrence: newTodo };
  }
  /**
   * Returns the original line while the todo is unchanged, so saving a loaded
   * file cannot silently reorder tags or rewrite line endings. Once a field
   * changes, the canonical form is used.
   */
  toString() {
    const serialized = this.serialize();
    if (this.originalLine !== undefined) {
      if (this.hasTwoLeadingDates) {
        // A two-date line cannot be canonicalised without dropping a token.
        // Keep the raw line while unchanged; refuse to serialize a mutation
        // that would silently lose it.
        if (serialized === this.originalSerialized) {
          return this.originalLine;
        }
        throw new AmbiguousTodoError();
      }
      if (serialized === this.originalSerialized) {
        return this.originalLine;
      }
    }
    return serialized;
  }

  private serialize() {
    // Completed todos must be serialized as
    // "x [priority] <completionDate> <creationDate> <text> [tags]" so that
    // parseTodoHeader parses the dates back into the same fields. Open todos
    // only carry a creation date.
    const dates: string[] = [];
    // The literal prefix of a line with an invalid token is already part of
    // `text`; emitting the parsed dates too would duplicate a valid token.
    if (this.invalidDateTokens.length === 0) {
      if (this.isDone()) {
        // On a done line a lone date is the completion date by format.
        if (this.completionDate) dates.push(formatDate(this.completionDate));
        if (this.creationDate) dates.push(formatDate(this.creationDate));
      } else if (this.creationDate) {
        dates.push(formatDate(this.creationDate));
      }
    }

    return (this.isDone() ? "x " : "") +
      (this.priority ? `(${this.priority}) ` : "") +
      dates.map((date) => date + " ").join("") +
      this.text +
      (Object.keys(this.tags).length > 0 ? " " : "") +
      serializeTags(this.tags);
  }

  toDisplayString() {
    if (this.hasTwoLeadingDates && this.originalLine !== undefined) {
      // Show both dates so the user can see why an update is rejected. This
      // deliberately differs from canonical rows, which hide the creation
      // date, so `search` can match these literal tokens.
      if (this.serialize() !== this.originalSerialized) {
        throw new AmbiguousTodoError();
      }
      return this.originalLine;
    }
    return (this.isDone() ? "x " : "") +
      (this.priority ? `(${this.priority}) ` : "") +
      // Creation dates are omitted from the display string. Only a completed
      // todo shows a date and it is always its completion date. A line with an
      // invalid token already carries its literal dates in `text`.
      (this.invalidDateTokens.length === 0 && this.isDone() &&
          this.completionDate
        ? formatDate(this.completionDate) + " "
        : "") +
      this.text +
      (Object.keys(this.tags).length > 0 ? " " : "") +
      serializeTags(this.tags);
  }

  isDone() {
    return this.state === TodoStateEnum.done;
  }

  /** True when the todo carries an `h:` tag other than `h:0`. */
  isHidden(): boolean {
    const values = Array.isArray(this.tags.h) ? this.tags.h : [this.tags.h];
    return values.some((value) => value !== undefined && value !== "0");
  }

  /**
   * True when the todo has no `t:` threshold, the threshold is invalid, or its
   * UTC calendar day has been reached. Invalid dates are kept visible rather
   * than silently hiding data.
   */
  isPassedThreshold(now: Date = new Date()): boolean {
    const threshold = parseDateTag(this.tags.t);
    return threshold === undefined || startOfUtcDay(now) >= threshold;
  }

  setText(text: string) {
    this.projects.clear();

    const matchProjects = text.matchAll(PROJECT_REGEX);
    for (const project of matchProjects) {
      this.projects.add(project.groups!.name);
    }

    this.contexts.clear();
    const matchContexts = text.matchAll(CONTEXT_REGEX);
    for (const context of matchContexts) {
      this.contexts.add(context.groups!.name);
    }

    const matchTags = text.matchAll(TAG_REGEX);
    for (const tag of matchTags) {
      const key = tag.groups!.key;
      const value = tag.groups!.value;
      const existing = this.tags[key];
      const alreadyPresent = existing === value ||
        (Array.isArray(existing) && existing.includes(value));
      // Re-applying the same body (a common follow-up edit) must not append an
      // identical tag, which would render as `due:2026-12-15,2026-12-15`.
      if (!alreadyPresent) {
        switch (typeof existing) {
          case "object":
            this.tags[key] = [...existing, value];
            break;
          case "string":
            this.tags[key] = [existing, value];
            break;
          default:
            this.tags[key] = value;
        }
      }
      text = text.replace(tag[0], "");
    }
    this.text = text;
  }

  setTag(key: string, value: string): void {
    this.tags[key] = value;
  }

  setDue(date: Date): void {
    this.setTag("due", date.toISOString().substring(0, 10));
  }

  setThreshold(date: Date): void {
    this.setTag("t", date.toISOString().substring(0, 10));
  }

  async getHash(): Promise<string> {
    const msgUint8 = new TextEncoder().encode(this.toString());
    const hashBuffer = await crypto.subtle.digest("SHA-256", msgUint8);
    // 64-bit content hash, base64url (11 chars, no padding). Shorter than the
    // old 16-hex encoding and safe to use in tool arguments.
    return Buffer.from(hashBuffer).subarray(0, 8).toString("base64url");
  }
}
