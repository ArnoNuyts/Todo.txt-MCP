import { describe, expect, it } from "vitest";
import {
  aggregateRuns,
  createMockModel,
  runTask,
  ScriptedModel,
  textResponse,
  toOpenAiTools,
  toolCallResponse,
  usageTotals,
  type ChatMessage,
} from "../bench/agent-eval.ts";
import {
  AGENT_TASKS,
  type AgentTask,
} from "../bench/agent-tasks.ts";
import { Todo } from "../logic/todo.ts";

function lastHash(messages: readonly ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "tool" || message.content === null) {
      continue;
    }
    const match = message.content.match(/^\[?([A-Za-z0-9_-]{11})\]?(?=\s|$)/);
    if (match) {
      return match[1];
    }
  }
  throw new Error("No hash found in tool results");
}

function findTask(id: string): AgentTask {
  const task = AGENT_TASKS.find((candidate) => candidate.id === id);
  if (task === undefined) {
    throw new Error(`Task not found: ${id}`);
  }
  return task;
}

describe("agent eval harness", () => {
  it("converts MCP tool definitions to OpenAI function tools", () => {
    const addSchema = {
      type: "object" as const,
      properties: { text: { type: "string" } },
      required: ["text"],
    };
    const tools = [
      { name: "add_todo", description: "Add one todo", inputSchema: addSchema },
      { name: "list_todos", inputSchema: { type: "object" as const } },
    ];

    const converted = toOpenAiTools(tools);

    expect(converted).toHaveLength(2);
    expect(converted[0]).toEqual({
      type: "function",
      function: {
        name: "add_todo",
        description: "Add one todo",
        parameters: addSchema,
      },
    });
    expect(converted[1].function.description).toBe("");
  });

  it("runs an add -> edit -> mark-done loop against MockBackend", async () => {
    const task: AgentTask = {
      id: "test-add-edit-done",
      prompt:
        "Add a report, make it high priority, move it to @office, then finish it.",
      seed: () => [],
      verify: (todos) => {
        const target = todos.find((todo) =>
          todo.text.includes("Write report")
        );
        const ok = target?.isDone() === true &&
          target.priority === "A" &&
          target.contexts.has("office") &&
          !target.contexts.has("work");
        return { ok, detail: ok ? "added, edited, and done" : "state mismatch" };
      },
    };

    let modelCalls = 0;
    const model = new ScriptedModel((request, index) => {
      modelCalls += 1;
      if (index === 0) {
        return toolCallResponse(
          "add_todos",
          { todos: ["Write report @work"] },
          "call-add",
        );
      }
      if (index === 1) {
        return toolCallResponse(
          "update_todos",
          {
            edits: [{
              hash: lastHash(request.messages),
              priority: "A",
              removeContexts: ["work"],
              addContexts: ["office"],
            }],
          },
          "call-edit",
        );
      }
      if (index === 2) {
        return toolCallResponse(
          "mark_done",
          { hashes: [lastHash(request.messages)] },
          "call-done",
        );
      }
      return textResponse("Done.");
    });

    const record = await runTask(task, 1, {
      profile: "compact",
      maxTurns: 6,
      modelFactory: () => model,
      modelName: "test-model",
      temperature: 0,
    });

    expect(record.success).toBe(true);
    expect(record.toolCalls).toBe(3);
    expect(record.invalidToolCalls).toBe(0);
    expect(record.turns).toBe(4);
    expect(record.trace.map((entry) => entry.name)).toEqual([
      "add_todos",
      "update_todos",
      "mark_done",
    ]);
    expect(modelCalls).toBe(4);
  });

  it("feeds a failing tool call back to the model", async () => {
    const task: AgentTask = {
      id: "test-failure-feedback",
      prompt: "Edit a todo with an invalid hash.",
      seed: () => [],
      verify: () => ({ ok: false, detail: "expected failure" }),
    };

    let sawFeedback = false;
    const model = new ScriptedModel((request, index) => {
      if (index === 0) {
        return toolCallResponse(
          "update_todos",
          { edits: [{ hash: "0123456789abcdef", priority: "A" }] },
          "call-bad",
        );
      }
      sawFeedback = request.messages.some((message) =>
        message.role === "tool" &&
        (message.content ?? "").toLowerCase().includes("not found")
      );
      return textResponse("That todo does not exist.");
    });

    const record = await runTask(task, 1, {
      profile: "compact",
      maxTurns: 4,
      modelFactory: () => model,
      modelName: "test-model",
      temperature: 0,
    });

    expect(record.success).toBe(false);
    expect(record.invalidToolCalls).toBe(1);
    expect(record.trace[0].isError).toBe(true);
    expect(record.trace[0].text).toContain("not found");
    expect(sawFeedback).toBe(true);
  });

  it("includes structuredContent in the tool result sent to the model", async () => {
    const task: AgentTask = {
      id: "test-structured-results",
      prompt: "List my todos.",
      seed: () => [new Todo("Buy milk @home")],
      verify: (todos) => ({
        ok: todos.some((todo) => todo.text.includes("Buy milk")),
        detail: "state unchanged",
      }),
    };

    let sawTodo = false;
    const model = new ScriptedModel((request, index) => {
      if (index === 0) {
        return toolCallResponse("list_todos", {}, "call-list");
      }
      sawTodo = request.messages.some((message) =>
        message.role === "tool" &&
        (message.content ?? "").includes("Buy milk")
      );
      return textResponse("Listed.");
    });

    const record = await runTask(task, 1, {
      profile: "full",
      maxTurns: 4,
      modelFactory: () => model,
      modelName: "test-model",
      temperature: 0,
    });

    expect(sawTodo).toBe(true);
    expect(record.toolCalls).toBe(1);
  });

  it("grades read-only tasks from the final answer, not just tool use", async () => {
    const task = findTask("list-overdue");
    const model = new ScriptedModel((_request, index) => {
      if (index === 0) {
        return toolCallResponse(
          "list_todos",
          { status: "todo", format: "text" },
          "call-list",
        );
      }
      return textResponse("Book flights is overdue.");
    });

    const record = await runTask(task, 1, {
      profile: "core",
      maxTurns: 4,
      modelFactory: () => model,
      modelName: "test-model",
      temperature: 0,
    });

    expect(record.success).toBe(false);
    expect(record.detail).toContain("false positive=true");
  });

  it("stops cleanly at the max-turn limit and handles missing usage", async () => {
    const task: AgentTask = {
      id: "test-max-turns",
      prompt: "Keep listing forever.",
      seed: () => [new Todo("One @home")],
      verify: () => ({ ok: false, detail: "not finished" }),
    };

    let requests = 0;
    const model = new ScriptedModel(() => {
      requests += 1;
      return toolCallResponse("list_todos", {}, `call-${requests}`);
    });

    const record = await runTask(task, 1, {
      profile: "compact",
      maxTurns: 3,
      modelFactory: () => model,
      modelName: "test-model",
      temperature: 0,
    });

    expect(record.turns).toBe(3);
    expect(record.toolCalls).toBe(3);
    expect(requests).toBe(3);
    expect(record.promptTokens).toBe(0);
    expect(record.completionTokens).toBe(0);
    expect(record.totalTokens).toBe(0);
    expect(Number.isNaN(record.totalTokens)).toBe(false);
  });

  it("normalizes partial and missing usage fields", () => {
    expect(usageTotals(undefined)).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
    expect(usageTotals({ prompt_tokens: 10, completion_tokens: 5 })).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
    expect(usageTotals({ total_tokens: Number.NaN })).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
  });

  it("grades a task against the final state and via the offline model", async () => {
    const task = findTask("add-priority-context-due");

    const good = task.seed();
    good.push(
      new Todo("(A) Pay electricity bill @home +finance due:2026-12-01"),
      new Todo("(B) Book dentist @health due:2026-11-20"),
      new Todo("Renew passport @errands +travel due:2027-01-15"),
    );
    const addTrace = [{
      turn: 1,
      name: "add_todos",
      arguments: {},
      isError: false,
      text: "",
    }];
    expect(task.verify(good, addTrace, "").ok).toBe(true);
    expect(task.verify(task.seed(), [], "").ok).toBe(false);

    const record = await runTask(task, 1, {
      profile: "compact",
      maxTurns: 4,
      modelFactory: createMockModel,
      modelName: "mock-model",
      temperature: 0,
    });

    expect(record.success).toBe(true);
    expect(record.toolCalls).toBe(1);
  });

  it("aggregates profile metrics without dividing by zero", () => {
    const records = [
      {
        taskId: "a",
        taskPrompt: "a",
        profile: "compact" as const,
        trial: 1,
        success: true,
        detail: "ok",
        toolCalls: 3,
        invalidToolCalls: 1,
        turns: 4,
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        wallTimeMs: 10,
        finalText: "ok",
        trace: [],
      },
      {
        taskId: "b",
        taskPrompt: "b",
        profile: "compact" as const,
        trial: 1,
        success: false,
        detail: "bad",
        toolCalls: 1,
        invalidToolCalls: 0,
        turns: 2,
        promptTokens: 80,
        completionTokens: 10,
        totalTokens: 90,
        wallTimeMs: 20,
        finalText: "bad",
        trace: [],
      },
    ];

    const summary = aggregateRuns(records);

    expect(summary.successRate).toBe(0.5);
    expect(summary.avgToolCalls).toBe(2);
    expect(summary.avgTurns).toBe(3);
    expect(summary.avgTotalTokens).toBe(105);
    expect(summary.tokensPerSuccess).toBe(210);
    expect(aggregateRuns([]).tokensPerSuccess).toBeNull();
  });
});
