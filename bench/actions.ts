/**
 * Protocol-cost benchmark for the only tool surface: add a batch, update
 * priorities/contexts for a batch, and mark a batch done.
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

const approxTokens = (value: unknown) =>
  Math.ceil(JSON.stringify(value).length / 4);

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
    content?: Array<{ text?: string }>;
  };
  const text = payload.content?.map((item) => item.text ?? "").join("\n") ?? "";
  return [...text.matchAll(/^\[?([A-Za-z0-9_-]{11})\]?/gm)]
    .map((match) => match[1]);
}

function verify(backend: MockBackend): boolean {
  const todos = backend.getTodos();
  const report = todos.find((todo) =>
    todo.text.includes("Prepare quarterly report")
  );
  const budget = todos.find((todo) => todo.text.includes("Draft budget"));
  const bill = todos.find((todo) => todo.text.includes("Pay electricity bill"));

  return todos.length === FILLERS + TARGETS.length + NEW_TODOS.length &&
    report?.isDone() === true &&
    report.priority === "A" &&
    report.contexts.has("office") &&
    !report.contexts.has("work") &&
    budget?.isDone() === true &&
    budget.priority === "A" &&
    budget.contexts.has("office") &&
    bill !== undefined &&
    bill.contexts.has("home");
}

async function runOnce() {
  const backend = new MockBackend();
  await backend.save(seedTodos());

  const server = createTodoMcpServer(backend);
  const [clientTransport, serverTransport] = InMemoryTransport
    .createLinkedPair();
  const client = new Client({ name: "actions-bench", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  let requests = 0;
  let responses = 0;
  let calls = 0;
  try {
    const tools = await client.listTools();
    const schema = approxTokens(tools);

    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      if ((result as { isError?: boolean }).isError === true) {
        throw new Error(`${name} failed: ${JSON.stringify(result)}`);
      }
      requests += approxTokens(args);
      responses += approxTokens(result);
      calls += 1;
      return result;
    };

    const hashes: string[] = [];
    for (const search of TARGET_SEARCHES) {
      const listed = await call("list_todos", { search });
      hashes.push(hashesOf(listed)[0]);
    }

    await call("add_todos", { todos: NEW_TODOS });

    const updated = await call("update_todos", {
      edits: hashes.map((hash) => ({
        hash,
        priority: "A",
        removeContexts: ["work"],
        addContexts: ["office"],
      })),
    });
    const newHashes = hashesOf(updated);

    await call("update_todos", {
      edits: newHashes.map((hash) => ({ hash, status: "done" })),
    });

    return {
      schema,
      variable: requests + responses,
      total: schema + requests + responses,
      calls,
      success: verify(backend),
    };
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

const runs: Awaited<ReturnType<typeof runOnce>>[] = [];
for (let i = 0; i < TRIALS; i++) {
  runs.push(await runOnce());
}

const median = (key: "schema" | "variable" | "total" | "calls") => {
  const values = runs.map((run) => run[key]).sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)];
};

console.log(`\n## Tool surface benchmark (median of ${TRIALS} runs)\n`);
console.log("| Measure | Tokens / calls |");
console.log("|---|---:|");
console.log(`| tools/list | ${median("schema")} |`);
console.log(`| request + response | ${median("variable")} |`);
console.log(`| **total** | **${median("total")}** |`);
console.log(`| tool calls | ${median("calls")} |`);
console.log(
  `\nSuccess: ${runs.filter((run) => run.success).length}/${TRIALS}`,
);
