/**
 * Protocol-cost benchmark for the three common single-todo actions:
 * add, edit (priority + context) and mark done.
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

const TARGET_SEARCH = "Prepare quarterly report";
const TARGET =
  `(C) 2025-01-02 ${TARGET_SEARCH} @work +finance due:2026-12-15`;
const NEW_TODO = "Pay electricity bill @home +finance due:2026-12-01";
const TRIALS = 5;
const FILLERS = 99;

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
  const todos = [new Todo(TARGET)];
  for (let i = 0; i < FILLERS; i++) {
    todos.push(
      new Todo(
        `(D) 2025-01-02 Filler task ${i} @ctx${i % 7} +proj${i % 9}`,
      ),
    );
  }
  return todos;
}

function firstHash(result: unknown): string {
  const payload = result as {
    content?: Array<{ type: string; text?: string }>;
  };
  const text = payload.content?.map((item) => item.text ?? "").join("\n") ?? "";
  const match = text.match(/^\[?([0-9a-f]{16})\]?/m);
  if (!match) {
    throw new Error(`No hash in tool result: ${text.slice(0, 200)}`);
  }
  return match[1];
}

function verify(backend: MockBackend): boolean {
  const todos = backend.getTodos();
  const target = todos.find((todo) => todo.text.includes(TARGET_SEARCH));
  const added = todos.find((todo) => todo.text.includes("Pay electricity bill"));
  return todos.length === FILLERS + 2 &&
    target !== undefined &&
    target.isDone() &&
    target.priority === "A" &&
    target.contexts.has("office") &&
    !target.contexts.has("work") &&
    added !== undefined &&
    added.contexts.has("home");
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

async function baseline(): Promise<RunResult> {
  return await runWorkflow("full", async ({ call }) => {
    const list1 = await call("lookup", "list_todos", {
      search: TARGET_SEARCH,
      format: "text",
    });
    const originalHash = firstHash(list1);

    await call("add", "add_todos", { todos: [NEW_TODO] });

    // The current update_todos cannot change a priority, so the smallest
    // correct workflow is export -> edit the line -> import replace.
    const exported = await call("edit", "export_todos", {});
    const exportedContent = (exported as {
      structuredContent: { content: string; version: string };
    }).structuredContent;
    const edited = exportedContent.content
      .split("\n")
      .map((line) =>
        line.includes(TARGET_SEARCH)
          ? line.replace(/^\([A-Z]\) /, "(A) ").replace("@work", "@office")
          : line
      )
      .join("\n");
    await call("edit", "import_todos", {
      content: edited,
      mode: "replace",
      expectedVersion: exportedContent.version,
    });

    // import_todos does not return hashes, so refresh before marking done.
    const list2 = await call("edit", "list_todos", {
      search: TARGET_SEARCH,
      format: "text",
    });
    const newHash = firstHash(list2);
    await call("done", "set_todo_statuses", {
      hashes: [newHash],
      status: "done",
    });

    if (originalHash === newHash) {
      throw new Error("baseline workflow did not change the target hash");
    }
  });
}

async function compact(): Promise<RunResult> {
  return await runWorkflow("compact", async ({ call }) => {
    const list = await call("lookup", "list_todos", {
      search: TARGET_SEARCH,
    });
    const hash = firstHash(list);

    await call("add", "add_todo", { text: NEW_TODO });

    const edited = await call("edit", "edit_todo", {
      hash,
      priority: "A",
      removeContexts: ["work"],
      addContexts: ["office"],
    });
    const newHash = firstHash(edited);

    await call("done", "mark_done", { hash: newHash });
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
console.log(row("add", baselineRuns.median("add"), compactRuns.median("add")));
console.log(row("edit priority+context", baselineRuns.median("edit"), compactRuns.median("edit")));
console.log(row("mark done", baselineRuns.median("done"), compactRuns.median("done")));
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
