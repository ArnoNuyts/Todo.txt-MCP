/**
 * LLM-in-the-loop usability benchmark for the server's tool profiles.
 *
 * Unlike `bench/actions.ts`, which measures the deterministic protocol cost of
 * a fixed workflow, this harness gives a model a natural-language task and the
 * actual MCP tools for a profile, then grades the final todo.txt state. It
 * works with any OpenAI-compatible `/chat/completions` endpoint and has an
 * offline `--mock` mode.
 *
 * Run a real evaluation:
 *   AGENT_EVAL_API_KEY=... AGENT_EVAL_MODEL=gpt-4.1-mini \
 *     npm run bench:agent -- --profiles compact,compact-plus,core,full --trials 1
 *
 * Run offline:
 *   npm run bench:agent -- --mock
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTodoMcpServer, type TodoToolset } from "../server.ts";
import { MockBackend } from "../test/helpers/mock-backend.ts";
import {
  AGENT_TASKS,
  type AgentTask,
  type ToolTraceEntry,
} from "./agent-tasks.ts";

export type AgentProfile = Extract<
  TodoToolset,
  "compact" | "compact-plus" | "core" | "full"
>;

export const AGENT_PROFILES: readonly AgentProfile[] = [
  "compact",
  "compact-plus",
  "core",
  "full",
];

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_TRIALS = 1;
const DEFAULT_MAX_TURNS = 12;

const SYSTEM_PROMPT =
  "You are an assistant operating a todo.txt MCP server. Use the provided " +
  "tools to complete the user's request. Tool results are the source of " +
  "truth: never invent hashes, read them from a list result. Do not make " +
  "destructive changes the user did not ask for. When the task is complete, " +
  "reply briefly.";

export interface ChatToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

export interface OpenAiTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ModelUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ChatCompletionChoice {
  message: {
    role?: string;
    content?: string | null;
    tool_calls?: ChatToolCall[];
  };
  finish_reason?: string;
}

export interface ChatCompletionResponse {
  choices: ChatCompletionChoice[];
  usage?: ModelUsage;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools: OpenAiTool[];
  temperature: number;
}

/** The only interface the agent loop needs from a model provider. */
export interface AgentModel {
  complete(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse>;
}

export type ModelFactory = (task: AgentTask) => AgentModel;

/** Minimal MCP tool shape; keeps this module independent of SDK internals. */
export interface McpToolLike {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** Converts MCP tool definitions into OpenAI function-calling tools. */
export function toOpenAiTools(
  tools: readonly McpToolLike[],
): OpenAiTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.inputSchema,
    },
  }));
}

function finiteOrZero(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Normalizes provider usage. Missing fields become zero and `total_tokens` is
 * derived from the prompt/completion counts when the provider omits it.
 */
export function usageTotals(
  usage: ModelUsage | undefined,
): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
} {
  const promptTokens = finiteOrZero(usage?.prompt_tokens);
  const completionTokens = finiteOrZero(usage?.completion_tokens);
  const reportedTotal = finiteOrZero(usage?.total_tokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens: reportedTotal > 0
      ? reportedTotal
      : promptTokens + completionTokens,
  };
}

export interface ScriptedResponder {
  (
    request: ChatCompletionRequest,
    callIndex: number,
  ): ChatCompletionResponse | Promise<ChatCompletionResponse>;
}

/** Deterministic model used by tests and custom offline experiments. */
export class ScriptedModel implements AgentModel {
  private readonly responder: ScriptedResponder;
  private callIndex = 0;

  constructor(responder: ScriptedResponder) {
    this.responder = responder;
  }

  complete(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    const index = this.callIndex;
    this.callIndex += 1;
    return Promise.resolve(this.responder(request, index));
  }
}

export function textResponse(content: string): ChatCompletionResponse {
  return {
    choices: [{
      message: { role: "assistant", content },
      finish_reason: "stop",
    }],
  };
}

export function toolCallResponse(
  name: string,
  args: Record<string, unknown>,
  id: string = "call",
): ChatCompletionResponse {
  return {
    choices: [{
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
      finish_reason: "tool_calls",
    }],
  };
}

function approxTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

function withEstimatedUsage(
  request: ChatCompletionRequest,
  response: ChatCompletionResponse,
): ChatCompletionResponse {
  const promptTokens = approxTokens({
    messages: request.messages,
    tools: request.tools,
  });
  const completionTokens = approxTokens(response.choices[0]?.message ?? {});
  return {
    ...response,
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

function latestHash(
  messages: readonly ChatMessage[],
  fragment: string,
): string | undefined {
  const needle = fragment.toLowerCase();
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "tool" || message.content === null) {
      continue;
    }
    for (const line of message.content.split("\n")) {
      if (!line.toLowerCase().includes(needle)) {
        continue;
      }
      const match = line.match(/\b[0-9a-f]{16}\b/);
      if (match) {
        return match[0];
      }
    }
  }
  return undefined;
}

/**
 * A scripted offline model that follows a task-aware plan using whichever
 * tools the active profile exposes. It is intentionally simple: its purpose is
 * to exercise the harness end to end without a network call, not to estimate
 * real model quality.
 */
class MockAgentModel implements AgentModel {
  private readonly task: AgentTask;
  private step = 0;
  private callId = 0;

  constructor(task: AgentTask) {
    this.task = task;
  }

  complete(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    const response = this.plan(request);
    this.step += 1;
    return Promise.resolve(withEstimatedUsage(request, response));
  }

  private tool(
    name: string,
    args: Record<string, unknown>,
  ): ChatCompletionResponse {
    this.callId += 1;
    return toolCallResponse(name, args, `mock-call-${this.callId}`);
  }

  private text(content: string): ChatCompletionResponse {
    return textResponse(content);
  }

  private plan(request: ChatCompletionRequest): ChatCompletionResponse {
    const has = (name: string) =>
      request.tools.some((tool) => tool.function.name === name);
    const compact = has("add_todo");
    const listArgs = (status: "todo" | "all") => ({
      status,
      limit: 100,
      ...(compact ? {} : { format: "text" as const }),
    });

    switch (this.task.id) {
      case "add-priority-context-due": {
        if (this.step > 0) {
          return this.text("Added the electricity bill task.");
        }
        const text =
          "(A) Pay electricity bill @home +finance due:2026-12-01";
        return compact
          ? this.tool("add_todo", { text })
          : this.tool("add_todos", { todos: [text] });
      }

      case "edit-priority-context": {
        if (this.step === 0) {
          return this.tool("list_todos", {
            search: "Prepare quarterly report",
            ...(compact ? {} : { format: "text" }),
          });
        }
        const hash = latestHash(
          request.messages,
          "Prepare quarterly report",
        ) ?? "0000000000000000";
        if (this.step === 1) {
          if (compact) {
            return this.tool("edit_todo", {
              hash,
              priority: "A",
              removeContexts: ["work"],
              addContexts: ["office"],
            });
          }
          return this.tool("delete_todos", { hashes: [hash] });
        }
        if (this.step === 2 && !compact) {
          return this.tool("add_todos", {
            todos: [
              "(A) 2025-01-02 Prepare quarterly report @office +finance " +
              "due:2026-12-15",
            ],
          });
        }
        return this.text("Updated the report task.");
      }

      case "mark-done": {
        if (this.step === 0) {
          return this.tool("list_todos", {
            search: "Call the dentist",
            ...(compact ? {} : { format: "text" }),
          });
        }
        if (this.step === 1) {
          const hash = latestHash(request.messages, "Call the dentist") ??
            "0000000000000000";
          return compact
            ? this.tool("mark_done", { hash })
            : this.tool("set_todo_statuses", {
              hashes: [hash],
              status: "done",
            });
        }
        return this.text("Marked the dentist task done.");
      }

      case "batch-add": {
        if (compact) {
          const texts = [
            "Buy milk @home",
            "Renew passport @errands",
            "Book a haircut @personal",
          ];
          if (this.step < texts.length) {
            return this.tool("add_todo", { text: texts[this.step] });
          }
          return this.text("Added all three tasks.");
        }
        if (this.step === 0) {
          return this.tool("add_todos", {
            todos: [
              "Buy milk @home",
              "Renew passport @errands",
              "Book a haircut @personal",
            ],
          });
        }
        return this.text("Added all three tasks.");
      }

      case "list-overdue": {
        if (this.step === 0) {
          return this.tool("list_todos", listArgs("todo"));
        }
        return this.text("The overdue task is File taxes.");
      }

      case "move-work-to-office": {
        if (this.step === 0) {
          return this.tool("list_todos", {
            search: "Draft budget",
            ...(compact ? {} : { format: "text" }),
          });
        }
        if (this.step === 1) {
          const hash = latestHash(request.messages, "Draft budget") ??
            "0000000000000000";
          return compact
            ? this.tool("edit_todo", {
              hash,
              removeContexts: ["work"],
              addContexts: ["office"],
            })
            : this.tool("update_todos", {
              edits: [{ hash, text: "Draft budget @office +finance" }],
            });
        }
        return this.text("Moved the budget task to @office.");
      }

      case "stale-hash-recovery": {
        if (this.step === 0) {
          return compact
            ? this.tool("mark_done", { hash: "deadbeefdeadbeef" })
            : this.tool("set_todo_statuses", {
              hashes: ["deadbeefdeadbeef"],
              status: "done",
            });
        }
        if (this.step === 1) {
          return this.tool("list_todos", {
            search: "Plan launch",
            ...(compact ? {} : { format: "text" }),
          });
        }
        if (this.step === 2) {
          const hash = latestHash(request.messages, "Plan launch") ??
            "0000000000000000";
          return compact
            ? this.tool("mark_done", { hash })
            : this.tool("set_todo_statuses", {
              hashes: [hash],
              status: "done",
            });
        }
        return this.text("Refreshed the hash and marked the task done.");
      }

      case "ambiguous-cleanup": {
        if (this.step === 0) {
          return this.tool("list_todos", listArgs("all"));
        }
        return this.text(
          "I can clean up completed tasks, but I will not delete anything " +
            "until you confirm which items you mean.",
        );
      }

      case "summary-counts": {
        if (has("summary")) {
          if (this.step === 0) {
            return this.tool("summary", {});
          }
          return this.text("There are three open tasks, one done, one overdue.");
        }
        if (compact) {
          if (this.step === 0) {
            return this.tool("list_todos", listArgs("all"));
          }
          return this.text("There are three open tasks, one done, one overdue.");
        }
        if (this.step === 0) {
          return this.tool("summary", {});
        }
        return this.text("There are three open tasks, one done, one overdue.");
      }

      case "changes-since": {
        if (has("changes_since")) {
          if (this.step === 0) {
            const version =
              this.task.prompt.match(/\b[0-9a-f]{64}\b/)?.[0] ?? "unknown";
            return this.tool("changes_since", { version });
          }
          return this.text("The file has changed since that version.");
        }
        if (compact) {
          if (this.step === 0) {
            return this.tool("list_todos", listArgs("all"));
          }
          return this.text("The file has changed since that version.");
        }
        if (this.step === 0) {
          const version =
            this.task.prompt.match(/\b[0-9a-f]{64}\b/)?.[0] ?? "unknown";
          return this.tool("changes_since", { version });
        }
        return this.text("The file has changed since that version.");
      }

      case "complete-overdue": {
        if (this.step === 0) {
          return this.tool("list_todos", listArgs("todo"));
        }
        if (this.step === 1) {
          const hash = latestHash(request.messages, "File taxes") ??
            "0000000000000000";
          return compact
            ? this.tool("mark_done", { hash })
            : this.tool("set_todo_statuses", {
              hashes: [hash],
              status: "done",
            });
        }
        return this.text("Marked the overdue task done.");
      }

      default: {
        if (this.step === 0) {
          return this.tool("list_todos", listArgs("todo"));
        }
        return this.text("Done.");
      }
    }
  }
}

export function createMockModel(task: AgentTask): AgentModel {
  return new MockAgentModel(task);
}

export interface OpenAiCompatibleOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  fetchImpl?: typeof fetch;
}

/** Provider-agnostic client for an OpenAI-compatible chat completions API. */
export class OpenAICompatibleModel implements AgentModel {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly temperature: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiCompatibleOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
    this.model = options.model;
    this.temperature = options.temperature;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model || this.model,
        messages: request.messages,
        temperature: request.temperature,
        ...(request.tools.length > 0 ? { tools: request.tools } : {}),
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Chat completions request failed (${response.status}): ` +
          body.slice(0, 500),
      );
    }

    const payload = await response.json() as ChatCompletionResponse & {
      error?: { message?: string };
    };
    if (payload.error) {
      throw new Error(
        `Provider error: ${payload.error.message ?? "unknown error"}`,
      );
    }
    if (!Array.isArray(payload.choices) || payload.choices.length === 0) {
      throw new Error("Chat completions response had no choices");
    }
    return payload;
  }
}

export interface RunOptions {
  profile: AgentProfile;
  maxTurns: number;
  modelFactory: ModelFactory;
  modelName: string;
  temperature: number;
  systemPrompt?: string;
}

export interface RunRecord {
  taskId: string;
  taskPrompt: string;
  profile: AgentProfile;
  trial: number;
  success: boolean;
  detail: string;
  toolCalls: number;
  invalidToolCalls: number;
  turns: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  wallTimeMs: number;
  finalText: string;
  trace: ToolTraceEntry[];
}

export interface ProfileSummary {
  profile: AgentProfile;
  runs: number;
  successes: number;
  successRate: number;
  toolCalls: number;
  invalidToolCalls: number;
  turns: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  wallTimeMs: number;
  avgToolCalls: number;
  avgTurns: number;
  avgTotalTokens: number;
  tokensPerSuccess: number | null;
}

interface ToolExecutionResult {
  text: string;
  isError: boolean;
}

export function parseToolArguments(raw: string): Record<string, unknown> {
  if (raw.trim() === "") {
    return {};
  }
  const value: unknown = JSON.parse(raw);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tool arguments must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function toolResultText(result: unknown): string {
  const payload = result as {
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: unknown;
  };
  const text = (payload.content ?? [])
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
  const parts: string[] = [];
  if (text.length > 0) {
    parts.push(text);
  }
  // MCP clients decide whether the model sees structuredContent. This harness
  // includes it (as JSON) so profile comparisons are not skewed by a client
  // that silently drops the machine-readable half of a tool result.
  if (payload.structuredContent !== undefined) {
    parts.push(JSON.stringify(payload.structuredContent));
  }
  if (parts.length > 0) {
    return parts.join("\n");
  }
  return JSON.stringify(result);
}

async function executeToolCall(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  tools: readonly OpenAiTool[],
): Promise<ToolExecutionResult> {
  if (!tools.some((tool) => tool.function.name === name)) {
    return {
      text: `Error: unknown tool "${name}". Available tools: ` +
        tools.map((tool) => tool.function.name).join(", "),
      isError: true,
    };
  }

  try {
    const result = await client.callTool({ name, arguments: args });
    const isError = (result as { isError?: boolean }).isError === true;
    return { text: toolResultText(result), isError };
  } catch (error) {
    return {
      text: `Error: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

/** Runs one task/trial against a fresh backend and an in-memory MCP client. */
export async function runTask(
  task: AgentTask,
  trial: number,
  options: RunOptions,
): Promise<RunRecord> {
  const started = performance.now();
  const backend = new MockBackend();
  await backend.save(task.seed());

  const server = createTodoMcpServer(backend, {
    toolset: options.profile,
  });
  const [clientTransport, serverTransport] = InMemoryTransport
    .createLinkedPair();
  const client = new Client({
    name: "todo-txt-mcp-agent-eval",
    version: "1.0.0",
  });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  const trace: ToolTraceEntry[] = [];
  let toolCalls = 0;
  let invalidToolCalls = 0;
  let turns = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let finalText = "";
  let failure: string | undefined;

  try {
    const { tools } = await client.listTools();
    const openAiTools = toOpenAiTools(tools);
    const model = options.modelFactory(task);
    const messages: ChatMessage[] = [
      { role: "system", content: options.systemPrompt ?? SYSTEM_PROMPT },
      { role: "user", content: task.prompt },
    ];

    for (let turn = 1; turn <= options.maxTurns; turn++) {
      turns = turn;
      const response = await model.complete({
        model: options.modelName,
        messages,
        tools: openAiTools,
        temperature: options.temperature,
      });

      const usage = usageTotals(response.usage);
      promptTokens += usage.promptTokens;
      completionTokens += usage.completionTokens;
      totalTokens += usage.totalTokens;

      const message = response.choices[0]?.message;
      if (message === undefined) {
        throw new Error("Model response had no choices");
      }
      const requestedCalls = message.tool_calls ?? [];
      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: message.content ?? null,
      };
      if (requestedCalls.length > 0) {
        assistantMessage.tool_calls = requestedCalls;
      }
      messages.push(assistantMessage);

      if (requestedCalls.length === 0) {
        finalText = message.content ?? "";
        break;
      }

      for (const call of requestedCalls) {
        toolCalls += 1;
        let args: Record<string, unknown>;
        try {
          args = parseToolArguments(call.function.arguments);
        } catch (error) {
          invalidToolCalls += 1;
          const text = `Error: ` +
            (error instanceof Error ? error.message : String(error));
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: text,
          });
          trace.push({
            turn,
            name: call.function.name,
            arguments: {},
            isError: true,
            text,
          });
          continue;
        }

        const result = await executeToolCall(
          client,
          call.function.name,
          args,
          openAiTools,
        );
        if (result.isError) {
          invalidToolCalls += 1;
        }
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: result.text,
        });
        trace.push({
          turn,
          name: call.function.name,
          arguments: args,
          isError: result.isError,
          text: result.text,
        });
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  let success = false;
  let detail: string;
  if (failure !== undefined) {
    detail = `run failed: ${failure}`;
  } else {
    const grade = task.verify(backend.getTodos(), trace, finalText);
    success = grade.ok;
    detail = grade.detail;
  }

  await Promise.allSettled([client.close(), server.close()]);

  return {
    taskId: task.id,
    taskPrompt: task.prompt,
    profile: options.profile,
    trial,
    success,
    detail,
    toolCalls,
    invalidToolCalls,
    turns,
    promptTokens,
    completionTokens,
    totalTokens,
    wallTimeMs: performance.now() - started,
    finalText,
    trace,
  };
}

export function aggregateRuns(runs: readonly RunRecord[]): ProfileSummary {
  const profile = runs[0]?.profile ?? "compact";
  const count = runs.length;
  const successes = runs.filter((run) => run.success).length;
  const toolCalls = runs.reduce((sum, run) => sum + run.toolCalls, 0);
  const invalidToolCalls = runs.reduce(
    (sum, run) => sum + run.invalidToolCalls,
    0,
  );
  const turns = runs.reduce((sum, run) => sum + run.turns, 0);
  const promptTokens = runs.reduce((sum, run) => sum + run.promptTokens, 0);
  const completionTokens = runs.reduce(
    (sum, run) => sum + run.completionTokens,
    0,
  );
  const totalTokens = runs.reduce((sum, run) => sum + run.totalTokens, 0);
  const wallTimeMs = runs.reduce((sum, run) => sum + run.wallTimeMs, 0);

  return {
    profile,
    runs: count,
    successes,
    successRate: count === 0 ? 0 : successes / count,
    toolCalls,
    invalidToolCalls,
    turns,
    promptTokens,
    completionTokens,
    totalTokens,
    wallTimeMs,
    avgToolCalls: count === 0 ? 0 : toolCalls / count,
    avgTurns: count === 0 ? 0 : turns / count,
    avgTotalTokens: count === 0 ? 0 : totalTokens / count,
    tokensPerSuccess: successes === 0 ? null : totalTokens / successes,
  };
}

interface CliOptions {
  profiles: AgentProfile[];
  trials: number;
  maxTurns: number;
  taskId?: string;
  jsonPath?: string;
  mock: boolean;
  model?: string;
  baseUrl?: string;
  help: boolean;
}

class CliUsageError extends Error {}

const USAGE = `Usage: npm run bench:agent -- [options]

Options:
  --profiles <list>   Comma-separated profiles (default: compact,compact-plus,core,full)
  --trials <n>        Trials per task/profile (default: ${DEFAULT_TRIALS})
  --max-turns <n>     Maximum model turns per run (default: ${DEFAULT_MAX_TURNS})
  --task <id>         Run only one task id
  --json <path>       Write full JSON results to this path
  --mock              Use the offline scripted model
  --model <name>      Override AGENT_EVAL_MODEL
  --base-url <url>    Override AGENT_EVAL_BASE_URL
  --help              Show this help

Environment:
  AGENT_EVAL_API_KEY or OPENAI_API_KEY
  AGENT_EVAL_BASE_URL (default: ${DEFAULT_BASE_URL})
  AGENT_EVAL_MODEL (required unless --mock)
  AGENT_EVAL_TEMPERATURE (default: 0)`;

const SETUP_INSTRUCTIONS = `No model credentials configured.

Set an API key and a model, then rerun:
  export AGENT_EVAL_API_KEY="sk-..."
  export AGENT_EVAL_MODEL="gpt-4.1-mini"
  npm run bench:agent -- --profiles compact,compact-plus,core,full --trials 1

Or run the offline harness with a scripted mock model:
  npm run bench:agent -- --mock

Optional overrides:
  AGENT_EVAL_BASE_URL (default: ${DEFAULT_BASE_URL})
  AGENT_EVAL_TEMPERATURE (default: 0)
  --model <name>, --base-url <url>`;

function parsePositiveInt(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CliUsageError(`${label} must be a positive integer`);
  }
  return parsed;
}

function isAgentProfile(value: string): value is AgentProfile {
  return (AGENT_PROFILES as readonly string[]).includes(value);
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    profiles: [...AGENT_PROFILES],
    trials: DEFAULT_TRIALS,
    maxTurns: DEFAULT_MAX_TURNS,
    mock: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const nextValue = (): string => {
      index += 1;
      const value = argv[index];
      if (value === undefined) {
        throw new CliUsageError(`Missing value for ${arg}`);
      }
      return value;
    };

    switch (arg) {
      case "--profiles": {
        const values = nextValue().split(",").map((value) => value.trim())
          .filter((value) => value.length > 0);
        if (values.length === 0) {
          throw new CliUsageError("--profiles must not be empty");
        }
        for (const value of values) {
          if (!isAgentProfile(value)) {
            throw new CliUsageError(
              `Unknown profile "${value}". Expected compact, compact-plus, ` +
                "core, or full.",
            );
          }
        }
        options.profiles = [...new Set(values as AgentProfile[])];
        break;
      }
      case "--trials":
        options.trials = parsePositiveInt(nextValue(), "--trials");
        break;
      case "--max-turns":
        options.maxTurns = parsePositiveInt(nextValue(), "--max-turns");
        break;
      case "--task":
        options.taskId = nextValue();
        break;
      case "--json":
        options.jsonPath = nextValue();
        break;
      case "--mock":
        options.mock = true;
        break;
      case "--model":
        options.model = nextValue();
        break;
      case "--base-url":
        options.baseUrl = nextValue();
        break;
      case "--help":
        options.help = true;
        break;
      default:
        throw new CliUsageError(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function parseTemperature(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return 0;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

function formatNumber(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : (0).toFixed(digits);
}

function printTable(
  summaries: readonly ProfileSummary[],
  trials: number,
  tasks: number,
): void {
  console.log(`\n## Agent usability by tool profile\n`);
  console.log(
    `Tasks: ${tasks}, trials per task: ${trials}, runs per profile: ` +
      `${tasks * trials}\n`,
  );
  console.log(
    "| Profile | Success rate | Avg tool calls | Invalid calls | " +
      "Avg turns | Avg total tokens | Tokens / success |",
  );
  console.log("|---|---:|---:|---:|---:|---:|---:|");
  for (const summary of summaries) {
    const success = `${summary.successes}/${summary.runs} ` +
      `(${formatNumber(summary.successRate * 100, 0)}%)`;
    const tokensPerSuccess = summary.tokensPerSuccess === null
      ? "n/a"
      : formatNumber(summary.tokensPerSuccess, 0);
    console.log(
      `| ${summary.profile} | ${success} | ` +
        `${formatNumber(summary.avgToolCalls, 1)} | ` +
        `${summary.invalidToolCalls} | ` +
        `${formatNumber(summary.avgTurns, 1)} | ` +
        `${formatNumber(summary.avgTotalTokens, 0)} | ` +
        `${tokensPerSuccess} |`,
    );
  }
}

function printFailures(runs: readonly RunRecord[]): void {
  const failures = runs.filter((run) => !run.success);
  if (failures.length === 0) {
    return;
  }
  console.log(`\n### Failed runs\n`);
  for (const run of failures) {
    console.log(
      `- ${run.profile} / ${run.taskId} (trial ${run.trial}): ${run.detail}`,
    );
  }
}

async function writeJson(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const tasks = options.taskId === undefined
    ? AGENT_TASKS
    : AGENT_TASKS.filter((task) => task.id === options.taskId);
  if (tasks.length === 0) {
    throw new CliUsageError(`Unknown task id: ${options.taskId}`);
  }

  const apiKey = process.env.AGENT_EVAL_API_KEY ||
    process.env.OPENAI_API_KEY;
  const baseUrl = options.baseUrl ||
    process.env.AGENT_EVAL_BASE_URL ||
    DEFAULT_BASE_URL;
  const modelName = options.model ||
    process.env.AGENT_EVAL_MODEL ||
    (options.mock ? "mock-model" : undefined);
  const temperature = parseTemperature(process.env.AGENT_EVAL_TEMPERATURE);

  if (!options.mock && (!apiKey || !modelName)) {
    console.error(SETUP_INSTRUCTIONS);
    process.exit(2);
  }

  const modelFactory: ModelFactory = options.mock
    ? (task) => createMockModel(task)
    : () => new OpenAICompatibleModel({
      apiKey: apiKey as string,
      baseUrl,
      model: modelName as string,
      temperature,
    });

  const runs: RunRecord[] = [];
  for (const profile of options.profiles) {
    for (const task of tasks) {
      for (let trial = 1; trial <= options.trials; trial++) {
        const run = await runTask(task, trial, {
          profile,
          maxTurns: options.maxTurns,
          modelFactory,
          modelName: modelName as string,
          temperature,
        });
        runs.push(run);
        console.error(
          `[${profile}] ${task.id} trial ${trial}: ` +
            `${run.success ? "ok" : "FAIL"}`,
        );
      }
    }
  }

  const summaries = options.profiles.map((profile) =>
    aggregateRuns(runs.filter((run) => run.profile === profile))
  );
  if (options.mock) {
    console.log(
      "\n> Mock mode: scripted planner. This verifies harness wiring and " +
        "graders, not model quality.\n",
    );
  }
  printTable(summaries, options.trials, tasks.length);
  printFailures(runs);

  if (options.jsonPath !== undefined) {
    await writeJson(options.jsonPath, {
      generatedAt: new Date().toISOString(),
      mode: options.mock ? "mock" : "live",
      model: modelName,
      baseUrl,
      temperature,
      maxTurns: options.maxTurns,
      trials: options.trials,
      tasks: tasks.map((task) => task.id),
      results: runs,
      summary: summaries,
    });
    console.error(`Wrote JSON results to ${options.jsonPath}`);
  }
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  import.meta.url === pathToFileURL(entryPoint).href
) {
  main().catch((error: unknown) => {
    if (error instanceof CliUsageError) {
      console.error(`error: ${error.message}\n`);
      console.error(USAGE);
      process.exit(2);
    }
    console.error(error);
    process.exit(1);
  });
}
