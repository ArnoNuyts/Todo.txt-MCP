import { TodoStateEnum } from "../types/enums.ts";
import { UpperCaseLetter } from "../types/types.ts";

const TODO_REGEX =
  /^((?<done>[x])\s){0,1}(\((?<prio>[A-Z])\)\s){0,1}((?<completionDate>\d{4}-[0-1][0-9]-[0-3][0-9])\s){0,1}((?<creationDate>\d{4}-[0-1][0-9]-[0-3][0-9])\s){0,1}(?<rest>[^\n\r]+)\s*$/;
const PROJECT_REGEX = /\s+\+(?<name>[\w.\_\-]+)/g;
const CONTEXT_REGEX = /\s+\@(?<name>[\w.\_\-]+)/g;
const TAG_REGEX = /\s+(?<key>[A-Za-z]+):(?<value>[^\s]+)/g;

export class Todo {
  // TODO: Find something better than this
  private signalChangeHack = 0;
  readonly id = Symbol();
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
      this.completionDate =
        match.groups.creationDate && match.groups.completionDate
          ? new Date(match.groups.completionDate)
          : undefined;
      this.creationDate =
        match.groups.creationDate || match.groups.completionDate
          ? new Date(match.groups.creationDate || match.groups.completionDate)
          : undefined;
      this.priority = match.groups.prio as UpperCaseLetter;
      text = match.groups.rest as string;
      this.state = match.groups.done ? TodoStateEnum.done : TodoStateEnum.todo;
    }
    this.setText(text);
  }
  toggleState() {
    this.state = this.state == TodoStateEnum.todo
      ? TodoStateEnum.done
      : TodoStateEnum.todo;
    if (this.state === TodoStateEnum.done && this.creationDate) {
      this.completionDate = new Date();
    }
    if (this.state === TodoStateEnum.todo && this.completionDate) {
      this.completionDate = undefined;
    }

    if (this.state === TodoStateEnum.done && this.tags.rec) {
      const recurrence = this.tags.rec as string;
      const newTodo = new Todo(this.toString());
      newTodo.state = TodoStateEnum.todo;
      newTodo.completionDate = undefined;

      const regex = /(\d+)([dwmy])/;
      const match = recurrence.match(regex);
      if (match) {
        const amount = parseInt(match[1]);
        const unit = match[2];
        const newDueDate = new Date();
        /*if (this.tags.due) {
          newDueDate = new Date(this.tags.due as string);
        }*/

        switch (unit) {
          case "d":
            newDueDate.setDate(newDueDate.getDate() + amount);
            break;
          case "w":
            newDueDate.setDate(newDueDate.getDate() + amount * 7);
            break;
          case "m":
            newDueDate.setMonth(newDueDate.getMonth() + amount);
            break;
          case "y":
            newDueDate.setFullYear(newDueDate.getFullYear() + amount);
            break;
        }
        newTodo.setDue(newDueDate);
      }

      return newTodo;
    }
  }
  toString() {
    return (this.isDone() ? "x " : "") +
      (this.priority ? `(${this.priority}) ` : "") +
      (this.creationDate
        ? this.creationDate!.toISOString().substring(0, 10) + " "
        : "") +
      (this.completionDate
        ? this.completionDate!.toISOString().substring(0, 10) + " "
        : "") +
      this.text +
      (Object.keys(this.tags).length > 0 ? " " : "") +
      (Object.keys(this.tags).map((k) => k + ":" + this.tags[k]).join(" "));
  }
  setPriority(key: UpperCaseLetter) {
    this.priority = key;
  }

  isDone() {
    return this.state == TodoStateEnum.done;
  }

  isHidden() {
    return !!this.tags["h"] && this.tags["h"] !== "0";
  }

  isVisibleInOverview() {
    return !this.isHidden() && this.isPassedThreshold();
  }

  isOverdue() {
    return typeof this.tags.due === "string" &&
      new Date() > new Date(this.tags.due);
  }

  isPassedThreshold() {
    return typeof this.tags.t !== "string" ||
      new Date() >= new Date(this.tags.t);
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
      switch (typeof this.tags[tag.groups!.key]) {
        case "object":
          this.tags[tag.groups!.key] = [
            ...this.tags[tag.groups!.key],
            tag.groups!.value,
          ];
          break;
        case "string":
          this.tags[tag.groups!.key] = [
            this.tags[tag.groups!.key] as string,
            tag.groups!.value,
          ];
          break;
        default:
          this.tags[tag.groups!.key] = tag.groups!.value;
      }
      text = text.replace(tag[0], "");
    }
    this.text = text;
  }

  setRecurrence(recurrence: string): void {
    this.tags.rec = recurrence;
    this.signalChangeHack++;
  }

  setDue(date: Date): void {
    this.tags.due = date.toISOString().substring(0, 10);
    this.signalChangeHack++;
  }

  setThreshold(date: Date): void {
    this.tags.t = date.toISOString().substring(0, 10);
    this.signalChangeHack++;
  }

  toggleHidden(): void {
    if (this.tags.h && this.tags.h !== "0") {
      delete this.tags.h;
    } else {
      this.tags.h = "1";
    }
    this.signalChangeHack++;
  }
}
