/**
 * Natural-language tasks and deterministic graders for the LLM usability
 * benchmark (`npm run bench:agent`).
 *
 * Every task has a seed fixture and a `verify` function that inspects the
 * final todo state through the normal `Todo` parser. Read-only tasks may also
 * inspect the tool trace, because their outcome is a retrieval rather than a
 * mutation.
 */
import { computeContentVersion } from "../logic/content.ts";
import { Todo } from "../logic/todo.ts";

/** One tool invocation observed during an agent run. */
export interface ToolTraceEntry {
  turn: number;
  name: string;
  arguments: Record<string, unknown>;
  isError: boolean;
  text: string;
}

export interface GradeResult {
  ok: boolean;
  detail: string;
}

export interface AgentTask {
  id: string;
  prompt: string;
  /** Fresh `Todo` instances, so a trial can never share mutable state. */
  seed: () => Todo[];
  verify: (
    todos: readonly Todo[],
    trace: readonly ToolTraceEntry[],
    finalText: string,
  ) => GradeResult;
}

function seeded(...lines: string[]): () => Todo[] {
  return () => lines.map((line) => new Todo(line));
}

function findTodo(
  todos: readonly Todo[],
  fragment: string,
): Todo | undefined {
  const needle = fragment.toLowerCase();
  return todos.find((todo) => todo.text.toLowerCase().includes(needle));
}

function hasContext(todo: Todo, name: string): boolean {
  const needle = name.toLowerCase();
  return [...todo.contexts].some((context) => context.toLowerCase() === needle);
}

function todoLines(todos: readonly Todo[]): string[] {
  return todos.map((todo) => todo.toString()).sort();
}

/** Compares the final state with the expected seed as a multiset of lines. */
function unchanged(todos: readonly Todo[], seedLines: readonly string[]): boolean {
  const actual = todoLines(todos);
  const expected = [...seedLines].sort();
  return actual.length === expected.length &&
    actual.every((line, index) => line === expected[index]);
}

function usedTool(trace: readonly ToolTraceEntry[], name: string): boolean {
  return trace.some((entry) => entry.name === name);
}

function succeeded(trace: readonly ToolTraceEntry[], name: string): boolean {
  return trace.some((entry) => entry.name === name && !entry.isError);
}

const ADD_SEED = [
  "(B) Existing report @work +finance due:2026-11-30",
];

const EDIT_SEED = [
  "(C) 2025-01-02 Prepare quarterly report @work +finance due:2026-12-15",
  "(D) 2025-01-02 Filler task @ctx +proj",
];

const MARK_DONE_SEED = [
  "Call the dentist @phone",
  "Buy milk @home",
  "(A) Renew passport @errands",
];

const BATCH_ADD_SEED = [
  "Existing task @home",
];

const OVERDUE_SEED = [
  "(A) File taxes @finance due:2020-04-15",
  "Book flights @travel due:2999-12-31",
  "x 2020-05-01 2020-04-01 Old overdue task @archive due:2020-04-01",
  "Buy milk @home",
];

const MOVE_SEED = [
  "Draft budget @work +finance",
  "Buy milk @home",
];

const STALE_HASH = "deadbeefdeadbeef";

const STALE_SEED = [
  "(A) Plan launch @work",
  "Buy milk @home",
];

const CLEANUP_SEED = [
  "Buy milk @home",
  "(A) File taxes @finance due:2020-04-15",
  "x 2020-05-01 2020-04-01 Old task @archive",
];

const SUMMARY_SEED = [
  "Buy milk @home",
  "(A) File taxes @finance due:2020-04-15",
  "x 2020-05-01 2020-04-01 Done task @archive",
  "Write report @work due:2999-01-01",
];

const CHANGES_SEED = [
  "Buy milk @home",
  "Write report @work",
];

const CHANGES_OLD_VERSION = computeContentVersion([
  new Todo("Something old @home"),
]);

export const AGENT_TASKS: readonly AgentTask[] = [
  {
    id: "add-priority-context-due",
    prompt:
      "Add a todo titled 'Pay electricity bill' with priority A, in the " +
      "@home context, under the +finance project, due 2026-12-01.",
    seed: seeded(...ADD_SEED),
    verify: (todos) => {
      const added = findTodo(todos, "Pay electricity bill");
      const ok = added !== undefined &&
        added.priority === "A" &&
        hasContext(added, "home") &&
        added.projects.has("finance") &&
        added.tags.due === "2026-12-01" &&
        todos.length === ADD_SEED.length + 1;
      return {
        ok,
        detail: added
          ? `added priority=${added.priority ?? "none"}, ` +
            `home=${hasContext(added, "home")}, ` +
            `finance=${added.projects.has("finance")}, ` +
            `due=${String(added.tags.due)}`
          : "added todo not found",
      };
    },
  },
  {
    id: "edit-priority-context",
    prompt:
      "Change 'Prepare quarterly report' from priority C to priority A and " +
      "move it from @work to @office. Keep the rest of the line unchanged.",
    seed: seeded(...EDIT_SEED),
    verify: (todos) => {
      const target = findTodo(todos, "Prepare quarterly report");
      const ok = target !== undefined &&
        target.priority === "A" &&
        hasContext(target, "office") &&
        !hasContext(target, "work") &&
        target.projects.has("finance") &&
        target.tags.due === "2026-12-15" &&
        !target.isDone() &&
        todos.length === EDIT_SEED.length;
      return {
        ok,
        detail: target
          ? `priority=${target.priority ?? "none"}, ` +
            `office=${hasContext(target, "office")}, ` +
            `work=${hasContext(target, "work")}, done=${target.isDone()}`
          : "target todo not found",
      };
    },
  },
  {
    id: "mark-done",
    prompt:
      "Mark the 'Call the dentist' task as done. Leave the other tasks alone.",
    seed: seeded(...MARK_DONE_SEED),
    verify: (todos) => {
      const target = findTodo(todos, "Call the dentist");
      const milk = findTodo(todos, "Buy milk");
      const passport = findTodo(todos, "Renew passport");
      const ok = target?.isDone() === true &&
        milk?.isDone() === false &&
        passport?.isDone() === false &&
        todos.length === MARK_DONE_SEED.length;
      return {
        ok,
        detail: `dentist done=${target?.isDone() ?? "missing"}, ` +
          `milk done=${milk?.isDone() ?? "missing"}, ` +
          `passport done=${passport?.isDone() ?? "missing"}`,
      };
    },
  },
  {
    id: "batch-add",
    prompt:
      "Add three tasks: 'Buy milk @home', 'Renew passport @errands', and " +
      "'Book a haircut @personal'.",
    seed: seeded(...BATCH_ADD_SEED),
    verify: (todos) => {
      const milk = findTodo(todos, "Buy milk");
      const passport = findTodo(todos, "Renew passport");
      const haircut = findTodo(todos, "Book a haircut");
      const ok = milk !== undefined && hasContext(milk, "home") &&
        passport !== undefined && hasContext(passport, "errands") &&
        haircut !== undefined && hasContext(haircut, "personal") &&
        todos.length === BATCH_ADD_SEED.length + 3;
      return {
        ok,
        detail: `milk=${milk !== undefined}, ` +
          `passport=${passport !== undefined}, ` +
          `haircut=${haircut !== undefined}, total=${todos.length}`,
      };
    },
  },
  {
    id: "list-overdue",
    prompt:
      "Which of my open tasks are overdue? List only the overdue ones and " +
      "do not change anything.",
    seed: seeded(...OVERDUE_SEED),
    verify: (todos, _trace, finalText) => {
      const stateUnchanged = unchanged(todos, OVERDUE_SEED);
      const answer = finalText.toLowerCase();
      const sawOverdue = answer.includes("file taxes");
      const falsePositive = answer.includes("book flights") ||
        answer.includes("buy milk");
      const read = usedTool(_trace, "list_todos") ||
        usedTool(_trace, "summary");
      const ok = stateUnchanged && sawOverdue && !falsePositive && read;
      return {
        ok,
        detail: `state unchanged=${stateUnchanged}, ` +
          `read=${read}, overdue answer=${sawOverdue}, ` +
          `false positive=${falsePositive}`,
      };
    },
  },
  {
    id: "move-work-to-office",
    prompt:
      "Move the 'Draft budget' task from @work to @office. Keep its " +
      "+finance project.",
    seed: seeded(...MOVE_SEED),
    verify: (todos) => {
      const target = findTodo(todos, "Draft budget");
      const ok = target !== undefined &&
        hasContext(target, "office") &&
        !hasContext(target, "work") &&
        target.projects.has("finance") &&
        todos.length === MOVE_SEED.length;
      return {
        ok,
        detail: target
          ? `office=${hasContext(target, "office")}, ` +
            `work=${hasContext(target, "work")}, ` +
            `finance=${target.projects.has("finance")}`
          : "target todo not found",
      };
    },
  },
  {
    id: "stale-hash-recovery",
    prompt:
      `I saved the hash ${STALE_HASH} for the 'Plan launch' task, but I am ` +
      "not sure it is current. Mark 'Plan launch' done. If that hash is " +
      "stale, refresh the task list and try once more.",
    seed: seeded(...STALE_SEED),
    verify: (todos, trace) => {
      const target = findTodo(todos, "Plan launch");
      const milk = findTodo(todos, "Buy milk");
      const staleAttempt = trace.some((entry) =>
        JSON.stringify(entry.arguments).includes(STALE_HASH)
      );
      const staleRejected = trace.some((entry) =>
        JSON.stringify(entry.arguments).includes(STALE_HASH) &&
        (entry.isError || entry.text.toLowerCase().includes("not found"))
      );
      const ok = target?.isDone() === true &&
        milk?.isDone() === false &&
        staleAttempt &&
        staleRejected &&
        todos.length === STALE_SEED.length;
      return {
        ok,
        detail: `plan done=${target?.isDone() ?? "missing"}, ` +
          `stale attempted=${staleAttempt}, rejected=${staleRejected}`,
      };
    },
  },
  {
    id: "ambiguous-cleanup",
    prompt: "Clean up my list.",
    seed: seeded(...CLEANUP_SEED),
    verify: (todos, trace, finalText) => {
      const stateUnchanged = unchanged(todos, CLEANUP_SEED);
      const answer = finalText.toLowerCase();
      const silentDelete = trace.some((entry) =>
        (entry.name === "delete_todos" || entry.name === "delete_completed") &&
        entry.arguments.dryRun !== true &&
        !entry.isError
      );
      const asksOrRefuses = answer.includes("confirm") ||
        answer.includes("which") ||
        answer.includes("won't delete") ||
        answer.includes("will not delete") ||
        answer.includes("cannot delete");
      const ok = stateUnchanged && !silentDelete && asksOrRefuses;
      return {
        ok,
        detail: `state unchanged=${stateUnchanged}, ` +
          `silent delete=${silentDelete}, asks/refuses=${asksOrRefuses}`,
      };
    },
  },
  {
    id: "summary-counts",
    prompt:
      "Give me a quick count: how many todos are open, how many are done, " +
      "and how many are overdue? Do not export or rewrite the file.",
    seed: seeded(...SUMMARY_SEED),
    verify: (todos, trace, finalText) => {
      const stateUnchanged = unchanged(todos, SUMMARY_SEED);
      const exported = succeeded(trace, "export_todos");
      const read = usedTool(trace, "summary") || usedTool(trace, "list_todos");
      const answer = finalText.toLowerCase();
      const answered = answer.includes("overdue") &&
        (answer.includes("open") || answer.includes("todo")) &&
        answer.includes("done");
      const ok = stateUnchanged && !exported && read && answered;
      return {
        ok,
        detail: `state unchanged=${stateUnchanged}, ` +
          `read=${read}, exported=${exported}, answered=${answered}`,
      };
    },
  },
  {
    id: "changes-since",
    prompt:
      `The last version I saw was ${CHANGES_OLD_VERSION}. Has the file ` +
      "changed since then, and if so what is different?",
    seed: seeded(...CHANGES_SEED),
    verify: (todos, trace, finalText) => {
      const stateUnchanged = unchanged(todos, CHANGES_SEED);
      const read = usedTool(trace, "changes_since") ||
        usedTool(trace, "list_todos");
      const answer = finalText.toLowerCase();
      const answered = answer.includes("changed") ||
        answer.includes("different") ||
        answer.includes("yes");
      const ok = stateUnchanged && read && answered;
      return {
        ok,
        detail: `state unchanged=${stateUnchanged}, ` +
          `changes_since=${usedTool(trace, "changes_since")}, ` +
          `read=${read}, answered=${answered}`,
      };
    },
  },
  {
    id: "complete-overdue",
    prompt:
      "Mark every open task that is overdue as done. Leave tasks that are " +
      "not overdue alone.",
    seed: seeded(...OVERDUE_SEED),
    verify: (todos) => {
      const taxes = findTodo(todos, "File taxes");
      const flights = findTodo(todos, "Book flights");
      const old = findTodo(todos, "Old overdue task");
      const milk = findTodo(todos, "Buy milk");
      const ok = taxes?.isDone() === true &&
        flights?.isDone() === false &&
        old?.isDone() === true &&
        milk?.isDone() === false &&
        todos.length === OVERDUE_SEED.length;
      return {
        ok,
        detail: `taxes done=${taxes?.isDone() ?? "missing"}, ` +
          `flights done=${flights?.isDone() ?? "missing"}, ` +
          `old done=${old?.isDone() ?? "missing"}, ` +
          `milk done=${milk?.isDone() ?? "missing"}`,
      };
    },
  },
];
