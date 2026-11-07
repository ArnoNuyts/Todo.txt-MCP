import { TodoStateEnum } from "../types/enums.ts";
import type { UpperCaseLetter } from "../types/types.ts";
import {
  nextRecurrence,
  parseDateTag,
  parseRecurrence,
  startOfUtcDay,
} from "./recurrence.ts";
import {
  CONTEXT_REGEX,
  PROJECT_REGEX,
  TAG_REGEX,
} from "./tokens.ts";

const TODO_REGEX =
  /^((?<done>[x])\s){0,1}(\((?<prio>[A-Z])\)\s){0,1}((?<completionDate>\d{4}-[0-1][0-9]-[0-3][0-9])\s){0,1}((?<creationDate>\d{4}-[0-1][0-9]-[0-3][0-9])\s){0,1}(?<rest>[^\n\r]+)\s*$/;

const formatDate = (date: Date) => date.toISOString().substring(0, 10);

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

  constructor(text: string) {
    const match = text.match(TODO_REGEX);
    if (match?.groups) {
      const { done, completionDate, creationDate } = match.groups;
      if (done) {
        // A completed todo is stored as "x <completionDate> <creationDate>":
        // the first optional date is the completion date, the second the
        // creation date. A lone date is therefore a completion date.
        this.completionDate = completionDate
          ? new Date(completionDate)
          : undefined;
        this.creationDate = creationDate ? new Date(creationDate) : undefined;
      } else {
        // An open todo has no completion date; a lone date is its creation
        // date.
        const date = creationDate ?? completionDate;
        this.creationDate = date ? new Date(date) : undefined;
        this.completionDate = undefined;
      }
      this.priority = match.groups.prio as UpperCaseLetter;
      text = match.groups.rest as string;
      this.state = match.groups.done ? TodoStateEnum.done : TodoStateEnum.todo;
    }
    this.setText(text);
  }
  /** Toggles completion and returns a recurrence todo when one is spawned. */
  toggleState(completedAt: Date = new Date()): { recurrence?: Todo } {
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
  toString() {
    // Completed todos must be serialized as
    // "x [priority] <completionDate> <creationDate> <text> [tags]" so that
    // TODO_REGEX parses the dates back into the same fields. Open todos only
    // carry a creation date.
    const dates: string[] = [];
    if (this.isDone()) {
      if (this.completionDate) dates.push(formatDate(this.completionDate));
      if (this.creationDate) dates.push(formatDate(this.creationDate));
    } else if (this.creationDate) {
      dates.push(formatDate(this.creationDate));
    }

    return (this.isDone() ? "x " : "") +
      (this.priority ? `(${this.priority}) ` : "") +
      dates.map((date) => date + " ").join("") +
      this.text +
      (Object.keys(this.tags).length > 0 ? " " : "") +
      serializeTags(this.tags);
  }

  toDisplayString() {
    return (this.isDone() ? "x " : "") +
      (this.priority ? `(${this.priority}) ` : "") +
      // Creation dates are omitted from the display string. Only a completed
      // todo shows a date and it is always its completion date.
      (this.isDone() && this.completionDate
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
    const value = Array.isArray(this.tags.h) ? this.tags.h[0] : this.tags.h;
    return value !== undefined && value !== "0";
  }

  /**
   * True when the todo has no `t:` threshold, the threshold is invalid, or its
   * calendar day has been reached. Invalid dates are kept visible rather than
   * silently hiding data.
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
