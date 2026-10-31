import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import express from "express";
import type { Request, Response } from "express";
import cors from "cors";

import {
  buildCorsOptions,
  createBearerAuthMiddleware,
  DEFAULT_HOST,
  type HttpSecurityOptions,
  resolveHttpSecurityOptions,
} from "./logic/http-security.ts";

import { Todo } from "./logic/todo.ts";
import { TodoStateEnum } from "./types/enums.ts";
import type { TodoBackend } from "./logic/backend.ts";
import { withBackendLock } from "./logic/backend-lock.ts";
import { LocalFileBackend } from "./logic/backends/local-file-backend.ts";
import { WebDavBackend } from "./logic/backends/webdav-backend.ts";
import { loadConfig } from "./logic/config.ts";
import type { TodoTxtMcpConfig } from "./logic/config.ts";

// Schemas
export const AddTodoSchema = z.object({
  todos: z.array(z.string().max(2000)).max(100).describe(
    "The todo texts, each supports todo.txt format",
  ),
});

export const EditTodoSchema = z.object({
  edits: z.array(z.object({
    hash: z.string().describe("Hash of the todo to edit"),
    text: z.string().max(2000).describe("New text for the todo"),
  })).max(100).describe("An array of todo edits"),
});

export const ListTodosSchema = z.object({
  status: z.enum(["todo", "done", "all"]).optional().describe(
    "Filter by status: 'todo' (default), 'done', or 'all'",
  ),
  search: z.string().max(200).optional().describe(
    "Search query to filter todos by text",
  ),
  limit: z.number().int().min(1).max(500).optional().describe(
    "Maximum number of todos to return (default: 50)",
  ),
  offset: z.number().int().min(0).optional().describe(
    "Number of todos to skip (default: 0)",
  ),
});

export const SetTodoStatusSchema = z.object({
  hash: z.string().describe("Hash of the todo to update"),
  status: z.enum(["done", "todo"]).describe(
    "New status for the todo ('done' or 'todo')",
  ),
});

export const DeleteTodoSchema = z.object({
  hash: z.string().min(8).max(64).describe("Hash of the todo to delete"),
});

// Output schemas (raw shapes, as expected by registerTool)
const TodoOutputShape = {
  hash: z.string(),
  text: z.string(),
  state: z.number().int(),
  priority: z.string().optional(),
  creationDate: z.string().optional(),
  completionDate: z.string().optional(),
};

const ListTodosOutputShape = {
  todos: z.array(z.object(TodoOutputShape)),
  total: z.number().int(),
  nextOffset: z.number().int().nullable(),
};

const AddTodoOutputShape = {
  added: z.array(z.object({ hash: z.string(), text: z.string() })),
};

const EditTodoOutputShape = {
  edited: z.array(z.object({ hash: z.string(), text: z.string() })),
  missing: z.array(z.string()),
};

const SetTodoStatusOutputShape = {
  hash: z.string(),
  status: z.enum(["done", "todo"]),
  text: z.string(),
};

const DeleteTodoOutputShape = {
  deleted: z.literal(true),
  hash: z.string(),
};

export function createBackend(config: TodoTxtMcpConfig): TodoBackend {
  switch (config.backend) {
    case "webdav":
      return new WebDavBackend(
        config.webdav.url,
        config.webdav.username,
        config.webdav.password,
      );
    case "local":
      return new LocalFileBackend(config.local.filename);
    default: {
      const exhaustiveCheck: never = config;
      return exhaustiveCheck;
    }
  }
}

// Tool: add_todo handler
export async function addTodoHandler(
  backend: TodoBackend,
  rawArgs: unknown,
) {
  const { todos: todoTexts } = AddTodoSchema.parse(rawArgs);

  return await withBackendLock(backend, async () => {
    const todos = await backend.load();
    const newTodos: Todo[] = [];
    for (const text of todoTexts) {
      const newTodo = new Todo(text);
      if (!newTodo.creationDate) {
        newTodo.creationDate = new Date();
      }
      todos.push(newTodo);
      newTodos.push(newTodo);
    }
    await backend.save(todos);

    const added = await Promise.all(
      newTodos.map(async (todo) => ({
        hash: await todo.getHash(),
        text: todo.toDisplayString(),
      })),
    );
    const newTodoStrings = added.map(({ hash, text }) =>
      `Added todo [${hash}]: ${text}`
    );

    return {
      content: [
        {
          type: "text" as const,
          text: newTodoStrings.join("\n"),
        },
      ],
      structuredContent: { added },
    };
  });
}

export async function editTodoHandler(
  backend: TodoBackend,
  rawArgs: unknown,
) {
  const { edits } = EditTodoSchema.parse(rawArgs);

  return await withBackendLock(backend, async () => {
    const todos = await backend.load();
    const results: string[] = [];
    const edited: Array<{ hash: string; text: string }> = [];
    const missing: string[] = [];
    let changesMade = false;

    const todoHashMap = new Map<string, Todo>();
    for (const todo of todos) {
      todoHashMap.set(await todo.getHash(), todo);
    }

    for (const edit of edits) {
      const { hash, text } = edit;
      const todo = todoHashMap.get(hash);

      if (todo) {
        todo.setText(text);
        const newHash = await todo.getHash();
        const displayText = todo.toDisplayString();
        edited.push({ hash: newHash, text: displayText });
        results.push(`Edited todo [${newHash}]: ${displayText}`);
        changesMade = true;
      } else {
        missing.push(hash);
        results.push(`Todo with hash ${hash} not found.`);
      }
    }

    if (changesMade) {
      await backend.save(todos);
    }

    return {
      content: [
        {
          type: "text" as const,
          text: results.join("\n"),
        },
      ],
      structuredContent: { edited, missing },
    };
  });
}

export async function listTodosHandler(
  backend: TodoBackend,
  rawArgs: unknown,
) {
  const { status = "todo", search, limit = 50, offset = 0 } = ListTodosSchema
    .parse(rawArgs);
  const allTodos = await backend.load();

  let filteredTodos = allTodos;

  // Filter by status
  if (status !== "all") {
    const targetState = status === "done"
      ? TodoStateEnum.done
      : TodoStateEnum.todo;
    filteredTodos = filteredTodos.filter((t) => t.state === targetState);
  }

  // Filter by search query
  if (search) {
    const lowerSearch = search.toLowerCase();
    filteredTodos = filteredTodos.filter((t) =>
      t.text.toLowerCase().includes(lowerSearch)
    );
  }

  // Apply pagination
  const pagedTodos = filteredTodos.slice(offset, offset + limit);

  const todoEntries = await Promise.all(
    pagedTodos.map(async (todo) => ({
      hash: await todo.getHash(),
      text: todo.toDisplayString(),
      state: todo.state,
      priority: todo.priority,
      creationDate: todo.creationDate?.toISOString().substring(0, 10),
      completionDate: todo.completionDate?.toISOString().substring(0, 10),
    })),
  );

  const todoStrings = todoEntries.map(({ hash, text }) =>
    `[${hash}] ${text}`
  );

  const nextOffset = offset + pagedTodos.length < filteredTodos.length
    ? offset + pagedTodos.length
    : null;

  return {
    content: [
      {
        type: "text" as const,
        text: todoStrings.length > 0
          ? todoStrings.join("\n")
          : "No todos found matching criteria.",
      },
    ],
    structuredContent: {
      todos: todoEntries,
      total: filteredTodos.length,
      nextOffset,
    },
  };
}

export async function setTodoStatusHandler(
  backend: TodoBackend,
  rawArgs: unknown,
) {
  const { hash, status } = SetTodoStatusSchema.parse(rawArgs);

  return await withBackendLock(backend, async () => {
    const todos = await backend.load();

    const todoHashMap = new Map<string, Todo>();
    for (const todo of todos) {
      todoHashMap.set(await todo.getHash(), todo);
    }

    const todo = todoHashMap.get(hash);

    if (!todo) {
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: "Todo not found (file modified?)",
        }],
      };
    }

    const targetState = status === "done"
      ? TodoStateEnum.done
      : TodoStateEnum.todo;

    if (todo.state !== targetState) {
      const newTodo = todo.toggleState();
      if (newTodo) {
        todos.push(newTodo);
      }
      await backend.save(todos);
    }

    const newHash = await todo.getHash();
    const displayText = todo.toDisplayString();

    return {
      content: [
        {
          type: "text" as const,
          text: `Set todo [${newHash}] status to ${status}: ${displayText}`,
        },
      ],
      structuredContent: {
        hash: newHash,
        status,
        text: displayText,
      },
    };
  });
}

// Tool: delete_todo handler
export async function deleteTodoHandler(
  backend: TodoBackend,
  rawArgs: unknown,
) {
  const { hash } = DeleteTodoSchema.parse(rawArgs);

  return await withBackendLock(backend, async () => {
    const todos = await backend.load();

    let index = -1;
    for (let i = 0; i < todos.length; i++) {
      if (await todos[i].getHash() === hash) {
        index = i;
        break;
      }
    }

    if (index === -1) {
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: "Todo not found (file modified?)",
        }],
      };
    }

    todos.splice(index, 1);
    await backend.save(todos);

    return {
      content: [
        {
          type: "text" as const,
          text: `Deleted todo [${hash}]`,
        },
      ],
      structuredContent: { deleted: true as const, hash },
    };
  });
}

export function createTodoMcpServer(backend: TodoBackend) {
  const server = new McpServer({
    name: "todo.txt-mcp",
    version: "1.0.0",
  });

  // Register a prompt describing the todo.txt format
  server.registerPrompt(
    "todo_format",
    {
      description:
        "The todo.txt format includes tags (e.g., @home), contexts (e.g., +project), recurrence rec:+2w (e.g., 'every 2 weeks'), and the 'x' marker indicating a completed task.",
    },
    () => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text:
            "todo.txt is a plain-text task format with one task per line.\n\n" +
            "- A completed task starts with `x ` (e.g. `x 2024-06-02 Buy milk`).\n" +
            "- A priority is a single uppercase letter in parentheses at the start: `(A)` to `(Z)`.\n" +
            "- A creation date and (for completed tasks) a completion date use the `YYYY-MM-DD` format.\n" +
            "- Projects are written as `+project` and contexts as `@context`.\n" +
            "- Free-form `key:value` tags are allowed. Useful ones include `due:YYYY-MM-DD`, `t:YYYY-MM-DD` (threshold) and `rec:+2w` / `rec:1m` style recurrence rules for repeating tasks.\n\n" +
            "Example:\n" +
            "(A) 2024-06-01 Pay rent +home due:2024-06-30\n" +
            "x 2024-06-02 2024-06-01 Call the dentist @phone rec:+1m",
        },
      }],
    }),
  );

  // Tool: list_todos
  server.registerTool(
    "list_todos",
    {
      description:
        "List todos with optional status, search, limit, and offset filters.",
      inputSchema: ListTodosSchema.shape,
      outputSchema: ListTodosOutputShape,
      annotations: { readOnlyHint: true },
    },
    (rawArgs: unknown) => listTodosHandler(backend, rawArgs),
  );

  // Tool: add_todo
  server.registerTool(
    "add_todo",
    {
      description: "Add one or more todos in todo.txt format.",
      inputSchema: AddTodoSchema.shape,
      outputSchema: AddTodoOutputShape,
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    (rawArgs: unknown) => addTodoHandler(backend, rawArgs),
  );

  // Tool: edit_todo
  server.registerTool(
    "edit_todo",
    {
      description: "Edit one or more existing todos by hash.",
      inputSchema: EditTodoSchema.shape,
      outputSchema: EditTodoOutputShape,
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    (rawArgs: unknown) => editTodoHandler(backend, rawArgs),
  );

  // Tool: set_todo_status
  server.registerTool(
    "set_todo_status",
    {
      description: "Mark a todo done or active by hash.",
      inputSchema: SetTodoStatusSchema.shape,
      outputSchema: SetTodoStatusOutputShape,
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    (rawArgs: unknown) => setTodoStatusHandler(backend, rawArgs),
  );

  // Tool: delete_todo
  server.registerTool(
    "delete_todo",
    {
      description: "Delete a todo by hash.",
      inputSchema: DeleteTodoSchema.shape,
      outputSchema: DeleteTodoOutputShape,
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    (rawArgs: unknown) => deleteTodoHandler(backend, rawArgs),
  );

  return server;
}

export type CreateAppOptions = HttpSecurityOptions;

export function createApp(
  backend: TodoBackend,
  options: HttpSecurityOptions = {},
) {
  const { allowedHosts, allowedOrigins, authToken } =
    resolveHttpSecurityOptions(options);
  const app = express();

  // An empty allowlist means "no browser origins allowed". The transport
  // skips Origin validation when the list is empty, so pass a sentinel that
  // no real Origin can match to keep the behavior fail-closed.
  const transportOrigins = allowedOrigins.length > 0
    ? allowedOrigins
    : ["__no_origins_allowed__"];

  // Port-agnostic Host validation protects against DNS rebinding.
  app.use(hostHeaderValidation(allowedHosts));

  // Never emit CORS headers when no origins are explicitly allowed.
  if (allowedOrigins.length > 0) {
    app.use(cors(buildCorsOptions(allowedOrigins)));
  }

  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  if (authToken !== undefined) {
    app.use("/mcp", createBearerAuthMiddleware(authToken));
  }

  app.post("/mcp", async (req: Request, res: Response) => {
    // Create a new server and transport for each request to keep the
    // stateless endpoint free of request ID collisions.
    const server = createTodoMcpServer(backend);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      // Host validation is handled by the port-agnostic middleware above.
      allowedOrigins: [...transportOrigins],
      maxRequestBodySize: 64 * 1024,
    });

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });

  app.delete("/mcp", (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });

  return app;
}

export async function main() {
  let config: TodoTxtMcpConfig;
  try {
    config = await loadConfig();
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error("❌ Configuration Error in todo.txt-mcp-config.json:");
      error.issues.forEach((issue) => {
        console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
      });
      process.exitCode = 1;
      return;
    }
    if (error instanceof SyntaxError) {
      console.error(
        "❌ Configuration Error: todo.txt-mcp-config.json is not valid JSON.",
      );
      console.error(`  ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const backend = createBackend(config);
  const app = createApp(backend);

  const authToken = process.env.MCP_AUTH_TOKEN;
  if (authToken === undefined || authToken.trim() === "") {
    console.warn(
      "⚠️  MCP_AUTH_TOKEN is not set: the /mcp endpoint is unauthenticated. Set MCP_AUTH_TOKEN when exposing the server beyond localhost.",
    );
  }

  const port = Number(process.env.PORT ?? "3000");
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(
      `❌ Invalid PORT "${process.env.PORT}": expected an integer between 0 and 65535.`,
    );
    process.exitCode = 1;
    return;
  }

  const host = process.env.HOST ?? DEFAULT_HOST;

  const server = app.listen(port, host, () => {
    const address = server.address();
    const boundPort = typeof address === "object" && address !== null
      ? address.port
      : port;
    console.log(
      `todo.txt-mcp Server running on http://localhost:${boundPort}`,
    );
    console.log(`MCP Endpoint: http://localhost:${boundPort}/mcp`);
  });

  server.on("error", (error) => {
    console.error("❌ Failed to start todo.txt-mcp server:", error.message);
    process.exitCode = 1;
  });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      console.log(`Received ${signal}, shutting down.`);
      const forceExit = setTimeout(() => process.exit(1), 10_000);
      forceExit.unref();
      server.close(() => {
        clearTimeout(forceExit);
        process.exit(0);
      });
    });
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
