/**
 * Natural-language tasks and deterministic graders for the LLM usability
 * benchmark (`npm run bench:agent`).
 *
 * The write tasks are deliberately multi-item: they ask the model to add,
 * update, or complete several todos in one request. This measures whether the
 * batch tools are actually used, rather than rewarding a chatty loop of
 * single-item calls.
 *
 * Every task has a seed fixture and a `verify` function that inspects the
 * final todo state through the normal `Todo` parser. Read-only tasks may also
 * inspect the tool trace and final answer.
 */
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

function batchCalls(
  trace: readonly ToolTraceEntry[],
  names: readonly string[],
): number {
  return trace.filter((entry) => names.includes(entry.name)).length;
}

function claimsOverdue(finalText: string, names: readonly string[]): boolean {
  return finalText
    .toLowerCase()
    .split(/[\n.]/)
    .map((sentence) => sentence.trim())
    .some((sentence) =>
      names.some((name) => sentence.includes(name)) &&
      sentence.includes("overdue") &&
      !sentence.includes("not overdue") &&
      !sentence.includes("aren't overdue") &&
      !sentence.includes("isn't overdue") &&
      !sentence.includes("no due")
    );
}

const ADD_SEED = [
  "(B) Existing report @work +finance due:2026-11-30",
];

const ADD_TEXTS = [
  "(A) Pay electricity bill @home +finance due:2026-12-01",
  "(B) Book dentist @health due:2026-11-20",
  "Renew passport @errands +travel due:2027-01-15",
];

const EDIT_SEED = [
  "(C) 2025-01-02 Prepare quarterly report @work +finance due:2026-12-15",
  "(D) 2025-01-02 Draft budget @work +finance",
];

const MARK_DONE_SEED = [
  "Call the dentist @phone",
  "Buy milk @home",
  "(A) Renew passport @errands",
  "Unrelated task @work",
];

const BATCH_ADD_SEED = [
  "Existing task @home",
];

const BATCH_ADD_TEXTS = [
  "Buy milk @home",
  "Renew passport @errands",
  "Book a haircut @personal",
  "File receipts @finance",
  "Clean the desk @home",
];

const OVERDUE_SEED = [
  "(A) File taxes @finance due:2020-04-15",
  "(B) Submit report @work due:2021-01-10",
  "Book flights @travel due:2999-12-31",
  "x 2020-05-01 2020-04-01 Old overdue task @archive due:2020-04-01",
  "Buy milk @home",
];

const MOVE_SEED = [
  "Draft budget @work +finance",
  "Review contracts @work +legal",
  "Buy milk @home",
];

const STALE_HASHES = ["deadbeefdeadbeef", "cafebabecafebabe"];

const STALE_SEED = [
  "(A) Plan launch @work",
  "Buy milk @home",
  "Write report @work",
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

export const AGENT_TASKS: readonly AgentTask[] = [
  {
    id: "add-priority-context-due",
    prompt:
      "Add these three todos in one request: " +
      "'Pay electricity bill' with priority A, @home, +finance, due " +
      "2026-12-01; 'Book dentist' with priority B, @health, due 2026-11-20; " +
      "and 'Renew passport' with @errands, +travel, due 2027-01-15.",
    seed: seeded(...ADD_SEED),
    verify: (todos, trace) => {
      const bill = findTodo(todos, "Pay electricity bill");
      const dentist = findTodo(todos, "Book dentist");
      const passport = findTodo(todos, "Renew passport");
      const ok = bill !== undefined &&
        bill.priority === "A" &&
        hasContext(bill, "home") &&
        bill.projects.has("finance") &&
        bill.tags.due === "2026-12-01" &&
        dentist !== undefined &&
        dentist.priority === "B" &&
        hasContext(dentist, "health") &&
        dentist.tags.due === "2026-11-20" &&
        passport !== undefined &&
        hasContext(passport, "errands") &&
        passport.projects.has("travel") &&
        passport.tags.due === "2027-01-15" &&
        todos.length === ADD_SEED.length + ADD_TEXTS.length &&
        batchCalls(trace, ["add_todos"]) === 1;
      return {
        ok,
        detail: `bill=${bill?.priority ?? "missing"}, ` +
          `dentist=${dentist?.priority ?? "missing"}, ` +
          `passport=${passport !== undefined}, ` +
          `total=${todos.length}, add_batches=${batchCalls(trace, ["add_todos"])}`,
      };
    },
  },
  {
    id: "edit-priority-context",
    prompt:
      "In one update, change both 'Prepare quarterly report' and 'Draft " +
      "budget' to priority A, and move both from @work to @office. Keep " +
      "their projects and due date.",
    seed: seeded(...EDIT_SEED),
    verify: (todos) => {
      const report = findTodo(todos, "Prepare quarterly report");
      const budget = findTodo(todos, "Draft budget");
      const ok = report !== undefined &&
        report.priority === "A" &&
        hasContext(report, "office") &&
        !hasContext(report, "work") &&
        report.projects.has("finance") &&
        report.tags.due === "2026-12-15" &&
        budget !== undefined &&
        budget.priority === "A" &&
        hasContext(budget, "office") &&
        !hasContext(budget, "work") &&
        budget.projects.has("finance") &&
        !report.isDone() &&
        !budget.isDone() &&
        todos.length === EDIT_SEED.length;
      return {
        ok,
        detail: `report=${report?.priority ?? "missing"}/` +
          `office=${report ? hasContext(report, "office") : "missing"}, ` +
          `budget=${budget?.priority ?? "missing"}/` +
          `office=${budget ? hasContext(budget, "office") : "missing"}`,
      };
    },
  },
  {
    id: "mark-done",
    prompt:
      "Mark these three tasks done in one request: 'Call the dentist', " +
      "'Buy milk', and 'Renew passport'. Leave the other task alone.",
    seed: seeded(...MARK_DONE_SEED),
    verify: (todos, trace) => {
      const dentist = findTodo(todos, "Call the dentist");
      const milk = findTodo(todos, "Buy milk");
      const passport = findTodo(todos, "Renew passport");
      const unrelated = findTodo(todos, "Unrelated task");
      const ok = dentist?.isDone() === true &&
        milk?.isDone() === true &&
        passport?.isDone() === true &&
        unrelated?.isDone() === false &&
        todos.length === MARK_DONE_SEED.length &&
        batchCalls(trace, ["mark_done"]) === 1;
      return {
        ok,
        detail: `dentist=${dentist?.isDone() ?? "missing"}, ` +
          `milk=${milk?.isDone() ?? "missing"}, ` +
          `passport=${passport?.isDone() ?? "missing"}, ` +
          `batch_calls=${
            batchCalls(trace, ["mark_done"])
          }`,
      };
    },
  },
  {
    id: "batch-add",
    prompt:
      "Add these five tasks in one request: 'Buy milk @home', 'Renew " +
      "passport @errands', 'Book a haircut @personal', 'File receipts " +
      "@finance', and 'Clean the desk @home'.",
    seed: seeded(...BATCH_ADD_SEED),
    verify: (todos, trace) => {
      const names = [
        "Buy milk",
        "Renew passport",
        "Book a haircut",
        "File receipts",
        "Clean the desk",
      ];
      const found = names.filter((name) => findTodo(todos, name) !== undefined);
      const contextsOk = findTodo(todos, "Buy milk") !== undefined &&
        hasContext(findTodo(todos, "Buy milk")!, "home") &&
        hasContext(findTodo(todos, "Renew passport")!, "errands") &&
        hasContext(findTodo(todos, "Book a haircut")!, "personal") &&
        hasContext(findTodo(todos, "File receipts")!, "finance") &&
        hasContext(findTodo(todos, "Clean the desk")!, "home");
      const ok = found.length === names.length &&
        contextsOk &&
        todos.length === BATCH_ADD_SEED.length + names.length &&
        batchCalls(trace, ["add_todos"]) === 1;
      return {
        ok,
        detail: `found=${found.length}/${names.length}, ` +
          `contexts=${contextsOk}, total=${todos.length}, ` +
          `add_batches=${batchCalls(trace, ["add_todos"])}`,
      };
    },
  },
  {
    id: "list-overdue",
    prompt:
      "Which of my open tasks are overdue? List only the overdue ones and " +
      "do not change anything.",
    seed: seeded(...OVERDUE_SEED),
    verify: (todos, trace, finalText) => {
      const stateUnchanged = unchanged(todos, OVERDUE_SEED);
      const answer = finalText.toLowerCase();
      const sawBoth = answer.includes("file taxes") &&
        answer.includes("submit report");
      const falsePositive = claimsOverdue(
        finalText,
        ["book flights", "buy milk"],
      );
      const read = usedTool(trace, "list_todos") || usedTool(trace, "summary");
      const ok = stateUnchanged && sawBoth && !falsePositive && read;
      return {
        ok,
        detail: `state unchanged=${stateUnchanged}, ` +
          `read=${read}, both overdue=${sawBoth}, ` +
          `false positive=${falsePositive}`,
      };
    },
  },
  {
    id: "move-work-to-office",
    prompt:
      "Move both 'Draft budget' and 'Review contracts' from @work to " +
      "@office in one update. Keep their projects.",
    seed: seeded(...MOVE_SEED),
    verify: (todos) => {
      const budget = findTodo(todos, "Draft budget");
      const contracts = findTodo(todos, "Review contracts");
      const ok = budget !== undefined &&
        hasContext(budget, "office") &&
        !hasContext(budget, "work") &&
        budget.projects.has("finance") &&
        contracts !== undefined &&
        hasContext(contracts, "office") &&
        !hasContext(contracts, "work") &&
        contracts.projects.has("legal") &&
        todos.length === MOVE_SEED.length;
      return {
        ok,
        detail: `budget=${budget ? hasContext(budget, "office") : "missing"}, ` +
          `contracts=${
            contracts ? hasContext(contracts, "office") : "missing"
          }`,
      };
    },
  },
  {
    id: "stale-hash-recovery",
    prompt:
      `I saved hashes ${STALE_HASHES[0]} for 'Plan launch' and ` +
      `${STALE_HASHES[1]} for 'Buy milk', but they may be stale. Mark both ` +
      "done in one request. If they are stale, refresh the list and retry once.",
    seed: seeded(...STALE_SEED),
    verify: (todos, trace) => {
      const plan = findTodo(todos, "Plan launch");
      const milk = findTodo(todos, "Buy milk");
      const report = findTodo(todos, "Write report");
      const staleAttempt = trace.some((entry) =>
        STALE_HASHES.some((hash) =>
          JSON.stringify(entry.arguments).includes(hash)
        )
      );
      const refreshed = staleAttempt || usedTool(trace, "list_todos");
      const ok = plan?.isDone() === true &&
        milk?.isDone() === true &&
        report?.isDone() === false &&
        refreshed &&
        todos.length === STALE_SEED.length;
      return {
        ok,
        detail: `plan=${plan?.isDone() ?? "missing"}, ` +
          `milk=${milk?.isDone() ?? "missing"}, ` +
          `refreshed=${refreshed}, stale attempted=${staleAttempt}`,
      };
    },
  },
  {
    id: "ambiguous-cleanup",
    prompt:
      "Clean up my list. Do not delete anything until I confirm what you " +
      "plan to remove.",
    seed: seeded(...CLEANUP_SEED),
    verify: (todos, trace, finalText) => {
      const stateUnchanged = unchanged(todos, CLEANUP_SEED);
      const answer = finalText.toLowerCase();
      const asksOrRefuses = answer.includes("confirm") ||
        answer.includes("which") ||
        answer.includes("should i") ||
        answer.includes("shall i") ||
        answer.includes("want me to") ||
        answer.includes("before i") ||
        answer.includes("propose") ||
        answer.includes("won't delete") ||
        answer.includes("will not delete") ||
        answer.includes("cannot delete");
      const ok = stateUnchanged && asksOrRefuses;
      return {
        ok,
        detail: `state unchanged=${stateUnchanged}, ` +
          `asks/refuses=${asksOrRefuses}`,
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
      const read = usedTool(trace, "list_todos");
      const answer = finalText.toLowerCase();
      const answered = answer.includes("overdue") &&
        (answer.includes("open") || answer.includes("todo")) &&
        answer.includes("done");
      const ok = stateUnchanged && read && answered;
      return {
        ok,
        detail: `state unchanged=${stateUnchanged}, ` +
          `read=${read}, answered=${answered}`,
      };
    },
  },
  {
    id: "complete-overdue",
    prompt:
      "Mark every open task that is overdue as done in one request. Leave " +
      "tasks that are not overdue alone.",
    seed: seeded(...OVERDUE_SEED),
    verify: (todos, trace) => {
      const taxes = findTodo(todos, "File taxes");
      const report = findTodo(todos, "Submit report");
      const flights = findTodo(todos, "Book flights");
      const old = findTodo(todos, "Old overdue task");
      const milk = findTodo(todos, "Buy milk");
      const ok = taxes?.isDone() === true &&
        report?.isDone() === true &&
        flights?.isDone() === false &&
        old?.isDone() === true &&
        milk?.isDone() === false &&
        todos.length === OVERDUE_SEED.length &&
        batchCalls(trace, ["mark_done"]) === 1;
      return {
        ok,
        detail: `taxes=${taxes?.isDone() ?? "missing"}, ` +
          `report=${report?.isDone() ?? "missing"}, ` +
          `flights=${flights?.isDone() ?? "missing"}, ` +
          `batch_calls=${
            batchCalls(trace, ["mark_done"])
          }`,
      };
    },
  },
];
