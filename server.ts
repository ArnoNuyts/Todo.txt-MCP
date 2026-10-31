import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import type { Request, Response } from "express";
import cors from "cors";

import { Todo } from "./logic/todo.ts";
import { TodoStateEnum } from "./types/enums.ts";
import type { TodoBackend } from "./logic/backend.ts";
import { LocalFileBackend } from "./logic/backends/local-file-backend.ts";
import { WebDavBackend } from "./logic/backends/webdav-backend.ts";
import { loadConfig } from "./logic/config.ts";
import type { TodoTxtMcpConfig } from "./logic/config.ts";

// Schemas
export const AddTodoSchema = z.object({
  todos: z.array(z.string()).describe(
    "The todo texts, each supports todo.txt format",
  ),
});

export const EditTodoSchema = z.object({
  edits: z.array(z.object({
    hash: z.string().describe("Hash of the todo to edit"),
    text: z.string().describe("New text for the todo"),
  })).describe("An array of todo edits"),
});

export const ListTodosSchema = z.object({
  status: z.enum(["todo", "done", "all"]).optional().describe(
    "Filter by status: 'todo' (default), 'done', or 'all'",
  ),
  search: z.string().optional().describe(
    "Search query to filter todos by text",
  ),
  limit: z.number().optional().describe(
    "Maximum number of todos to return (default: 50)",
  ),
  offset: z.number().optional().describe(
    "Number of todos to skip (default: 0)",
  ),
});

export const SetTodoStatusSchema = z.object({
  hash: z.string().describe("Hash of the todo to update"),
  status: z.enum(["done", "todo"]).describe(
    "New status for the todo ('done' or 'todo')",
  ),
});

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

  const newTodoStrings = await Promise.all(
    newTodos.map(async (todo) =>
      `Added todo [${await todo.getHash()}]: ${todo.toDisplayString()}`
    ),
  );

  return {
    content: [
      {
        type: "text" as const,
        text: newTodoStrings.join("\n"),
      },
    ],
  };
}

export async function editTodoHandler(
  backend: TodoBackend,
  rawArgs: unknown,
) {
  const { edits } = EditTodoSchema.parse(rawArgs);
  const todos = await backend.load();
  const results: string[] = [];
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
      results.push(
        `Edited todo [${await todo.getHash()}]: ${todo.toDisplayString()}`,
      );
      changesMade = true;
    } else {
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
  };
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

  const todoStrings = await Promise.all(
    pagedTodos.map(async (todo) => {
      const hash = await todo.getHash();
      return `[${hash}] ${todo.toDisplayString()}`;
    }),
  );

  return {
    content: [
      {
        type: "text" as const,
        text: todoStrings.length > 0
          ? todoStrings.join("\n")
          : "No todos found matching criteria.",
      },
    ],
  };
}

export async function setTodoStatusHandler(
  backend: TodoBackend,
  rawArgs: unknown,
) {
  const { hash, status } = SetTodoStatusSchema.parse(rawArgs);
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
  return {
    content: [
      {
        type: "text" as const,
        text: `Set todo [${await todo
          .getHash()}] status to ${status}: ${todo.toDisplayString()}`,
      },
    ],
  };
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
    () => ({ messages: [] }),
  );

  // Tool: list_todos
  server.registerTool(
    "list_todos",
    {
      description:
        "List todos with optional status, search, limit, and offset filters.",
      inputSchema: ListTodosSchema.shape,
    },
    (rawArgs: unknown) => listTodosHandler(backend, rawArgs),
  );

  // Tool: add_todo
  server.registerTool(
    "add_todo",
    {
      description: "Add one or more todos in todo.txt format.",
      inputSchema: AddTodoSchema.shape,
    },
    (rawArgs: unknown) => addTodoHandler(backend, rawArgs),
  );

  // Tool: edit_todo
  server.registerTool(
    "edit_todo",
    {
      description: "Edit one or more existing todos by hash.",
      inputSchema: EditTodoSchema.shape,
    },
    (rawArgs: unknown) => editTodoHandler(backend, rawArgs),
  );

  // Tool: set_todo_status
  server.registerTool(
    "set_todo_status",
    {
      description: "Mark a todo done or active by hash.",
      inputSchema: SetTodoStatusSchema.shape,
    },
    (rawArgs: unknown) => setTodoStatusHandler(backend, rawArgs),
  );

  return server;
}

export function createApp(backend: TodoBackend) {
  const app = express();
  app.use(cors());

  app.post("/mcp", async (req: Request, res: Response) => {
    // Create a new server and transport for each request to keep the
    // stateless endpoint free of request ID collisions.
    const server = createTodoMcpServer(backend);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
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

  const port = Number(process.env.PORT ?? "3000");
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(
      `❌ Invalid PORT "${process.env.PORT}": expected an integer between 0 and 65535.`,
    );
    process.exitCode = 1;
    return;
  }

  const server = app.listen(port, () => {
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
