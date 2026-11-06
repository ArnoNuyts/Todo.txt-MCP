/**
 * Protocol-cost benchmark for a multi-item workflow: add several todos,
 * change priority + context on several existing todos, and mark several done.
 *
 * It measures what an MCP client actually pays: the tools/list payload plus
 * every tool request and result, in approximate tokens (chars / 4). The
 * workflow is deterministic and is verified against the final todo.txt state.
 *
 * Run with `npm run bench:actions`.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTodoMcpServer } from "../server.ts";
import { MockBackend } from "../test/helpers/mock-backend.ts";
import { Todo } from "../logic/todo.ts";

const TARGETS = [
  "(C) 2025-01-02 Prepare quarterly report @work +finance due:2026-12-15",
  "(D) 2025-01-02 Draft budget @work +finance",
];
const TARGET_SEARCHES = ["Prepare quarterly report", "Draft budget"];
const NEW_TODOS = [
  "(A) Pay electricity bill @home +finance due:2026-12-01",
  "(B) Book dentist @health due:2026-11-20",
  "(C) Renew passport @errands +travel due:2027-01-15",
];
const TRIALS = 5;
const FILLERS = 98;

type Phase = "lookup" | "add" | "edit" | "done";
type Stats = Record<Phase | "schema" | "requests" | "responses" | "calls", number>;

interface RunResult {
  stats: Stats;
  success: boolean;
}

interface CallContext {
  backend: MockBackend;
  call: (
    phase: Phase,
    name: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
}

const approxTokens = (value: unknown) =>
  Math.ceil(JSON.stringify(value).length / 4);

function emptyStats(): Stats {
  return {
    schema: 0,
    lookup: 0,
    add: 0,
    edit: 0,
    done: 0,
    requests: 0,
    responses: 0,
    calls: 0,
  };
}

function seedTodos(): Todo[] {
  const todos = TARGETS.map((line) => new Todo(line));
  for (let i = 0; i < FILLERS; i++) {
    todos.push(
      new Todo(
        `(D) 2025-01-02 Filler task ${i} @ctx${i % 7} +proj${i % 9}`,
      ),
    );
  }
  return todos;
}

function hashesOf(result: unknown): string[] {
  const payload = result as {
    content?: Array<{ type: string; text?: string }>;
  };
  const text = payload.content?.map((item) => item.text ?? "").join("\n") ?? "";
  return [...text.matchAll(/^\[?([0-9a-f]{16})\]?/gm)].map((match) => match[1]);
}

function firstHash(result: unknown): string {
  const hash = hashesOf(result)[0];
  if (hash === undefined) {
    throw new Error(`No hash in tool result: ${JSON.stringify(result)}`);
  }
  return hash;
}

function verify(backend: MockBackend): boolean {
  const todos = backend.getTodos();
  const report = todos.find((todo) =>
    todo.text.includes("Prepare quarterly report")
  );
  const budget = todos.find((todo) => todo.text.includes("Draft budget"));
  const bill = todos.find((todo) => todo.text.includes("Pay electricity bill"));
  const dentist = todos.find((todo) => todo.text.includes("Book dentist"));
  const passport = todos.find((todo) => todo.text.includes("Renew passport"));

  return todos.length === FILLERS + TARGETS.length + NEW_TODOS.length &&
    report?.isDone() === true &&
    report.priority === "A" &&
    report.contexts.has("office") &&
    !report.contexts.has("work") &&
    report.tags.due === "2026-12-15" &&
    budget?.isDone() === true &&
    budget.priority === "A" &&
    budget.contexts.has("office") &&
    !budget.contexts.has("work") &&
    bill !== undefined &&
    bill.contexts.has("home") &&
    dentist !== undefined &&
    dentist.contexts.has("health") &&
    passport !== undefined &&
    passport.contexts.has("errands");
}

async function runWorkflow(
  toolset: "full" | "core" | "compact",
  workflow: (ctx: CallContext) => Promise<void>,
): Promise<RunResult> {
  const backend = new MockBackend();
  await backend.save(seedTodos());

  const server = createTodoMcpServer(backend, { toolset });
  const [clientTransport, serverTransport] = InMemoryTransport
    .createLinkedPair();
  const client = new Client({ name: "actions-bench", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  const stats = emptyStats();
  const call = async (
    phase: Phase,
    name: string,
    args: Record<string, unknown>,
  ) => {
    const result = await client.callTool({ name, arguments: args });
    if ((result as { isError?: boolean }).isError === true) {
      throw new Error(`${name} failed: ${JSON.stringify(result)}`);
    }
    stats.requests += approxTokens(args);
    stats.responses += approxTokens(result);
    stats.calls += 1;
    stats[phase] += approxTokens(args) + approxTokens(result);
    return result;
  };

  try {
    const tools = await client.listTools();
    stats.schema = approxTokens(tools);
    await workflow({ backend, call });
    return { stats, success: verify(backend) };
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

async function targetHashes(
  call: CallContext["call"],
  phase: Phase,
): Promise<string[]> {
  const hashes: string[] = [];
  for (const search of TARGET_SEARCHES) {
    const result = await call(phase, "list_todos", {
      search,
      format: "text",
    });
    hashes.push(firstHash(result));
  }
  return hashes;
}

async function baseline(): Promise<RunResult> {
  return await runWorkflow("full", async ({ call }) => {
    const originalHashes = await targetHashes(call, "lookup");

    await call("add", "add_todos", { todos: NEW_TODOS });

    // The current update_todos cannot change a priority, so the smallest
    // correct batch workflow is export -> edit both lines -> import replace.
    const exported = await call("edit", "export_todos", {});
    const exportedContent = (exported as {
      structuredContent: { content: string; version: string };
    }).structuredContent;
    const edited = exportedContent.content
      .split("\n")
      .map((line) => {
        if (line.includes(TARGET_SEARCHES[0])) {
          return line.replace(/^\([A-Z]\) /, "(A) ").replace("@work", "@office");
        }
        if (line.includes(TARGET_SEARCHES[1])) {
          return line.replace(/^\([A-Z]\) /, "(A) ").replace("@work", "@office");
        }
        return line;
      })
      .join("\n");
    await call("edit", "import_todos", {
      content: edited,
      mode: "replace",
      expectedVersion: exportedContent.version,
    });

    // import_todos does not return hashes, so refresh both before marking done.
    const newHashes = await targetHashes(call, "done");
    await call("done", "set_todo_statuses", {
      hashes: newHashes,
      status: "done",
    });

    if (originalHashes.some((hash) => newHashes.includes(hash))) {
      throw new Error("baseline workflow did not change the target hashes");
    }
  });
}

async function compact(): Promise<RunResult> {
  return await runWorkflow("compact", async ({ call }) => {
    const hashes = await targetHashes(call, "lookup");

    await call("add", "add_todos", { todos: NEW_TODOS });

    const edited = await call("edit", "update_todos", {
      edits: hashes.map((hash) => ({
        hash,
        priority: "A",
        removeContexts: ["work"],
        addContexts: ["office"],
      })),
    });
    const newHashes = hashesOf(edited);
    if (newHashes.length !== hashes.length) {
      throw new Error("compact workflow did not return every new hash");
    }

    await call("done", "mark_done", { hashes: newHashes });
  });
}

async function measure(fn: () => Promise<RunResult>) {
  const runs: RunResult[] = [];
  for (let i = 0; i < TRIALS; i++) {
    runs.push(await fn());
  }
  const successes = runs.filter((run) => run.success).length;
  const median = (phase: keyof Stats) => {
    const values = runs.map((run) => run.stats[phase]).sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  };
  const total = median("schema") + median("lookup") + median("add") +
    median("edit") + median("done");
  return { successes, median, total };
}

const baselineRuns = await measure(baseline);
const compactRuns = await measure(compact);

function row(label: string, a: number, b: number) {
  const change = a === 0 ? "n/a" : `${(((a - b) / a) * 100).toFixed(0)}%`;
  return `| ${label} | ${a} | ${b} | ${change} |`;
}

console.log(`\n## Action benchmark (median of ${TRIALS} runs)\n`);
console.log("| Phase | full | compact | Reduction |");
console.log("|---|---:|---:|---:|");
console.log(row("tools/list", baselineRuns.median("schema"), compactRuns.median("schema")));
console.log(row("lookup", baselineRuns.median("lookup"), compactRuns.median("lookup")));
console.log(row("add 3 todos", baselineRuns.median("add"), compactRuns.median("add")));
console.log(row("edit 2 priorities+contexts", baselineRuns.median("edit"), compactRuns.median("edit")));
console.log(row("mark 2 done", baselineRuns.median("done"), compactRuns.median("done")));
console.log(row("**total tokens**", baselineRuns.total, compactRuns.total));
console.log(
  row(
    "**variable tokens** (no tools/list)",
    baselineRuns.total - baselineRuns.median("schema"),
    compactRuns.total - compactRuns.median("schema"),
  ),
);
console.log(
  row("tool calls", baselineRuns.median("calls"), compactRuns.median("calls")),
);
console.log(
  `\nSuccess: full ${baselineRuns.successes}/${TRIALS}, ` +
    `compact ${compactRuns.successes}/${TRIALS}`,
);
console.log(
  `Total reduction: ${
    (((baselineRuns.total - compactRuns.total) / baselineRuns.total) * 100)
      .toFixed(1)
  }%`,
);
