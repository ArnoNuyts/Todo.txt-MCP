import { McpServer } from "npm:@modelcontextprotocol/sdk@1.22.0/server/mcp.js";
import { z } from "npm:zod@3.25.1";
import { StreamableHTTPServerTransport } from "npm:@modelcontextprotocol/sdk@1.22.0/server/streamableHttp.js";
import express, { Request, Response } from "npm:express@5.1.0";
import cors from "npm:cors@2.8.5";

import { Todo } from "./logic/todo.ts";
import { TodoStateEnum } from "./types/enums.ts";
import { TodoBackend } from "./logic/backend.ts";
import { LocalFileBackend } from "./logic/backends/local-file-backend.ts";
import { WebDavBackend } from "./logic/backends/webdav-backend.ts";
import { loadConfig, TodoTxtMcpConfig } from "./logic/config.ts";

function createBackend(config: TodoTxtMcpConfig): TodoBackend {
  switch (config.backend) {
    case "webdav":
      return new WebDavBackend(
        config.webdav.url,
        config.webdav.username,
        config.webdav.password,
      );
    case "local":
      return new LocalFileBackend(config.local.filename);
  }
}

// Tool: add_todo handler
const AddTodoSchema = z.object({
  todos: z.array(z.string()).describe(
    "The todo texts, each supports todo.txt format",
  ),
});

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
  const EditTodoSchema = z.object({
    edits: z.array(z.object({
      hash: z.string().describe("Hash of the todo to edit"),
      text: z.string().describe("New text for the todo"),
    })),
  });
  const { edits } = EditTodoSchema.parse(rawArgs);
  const todos = await backend.load();
  const results: string[] = [];
  let changesMade = false;

  for (const edit of edits) {
    const { hash, text } = edit;
    let found = false;
    for (let i = 0; i < todos.length; i++) {
      if ((await todos[i].getHash()) === hash) {
        todos[i].setText(text);
        results.push(
          `Edited todo [${await todos[i].getHash()}]: ${
            todos[i].toDisplayString()
          }`,
        );
        found = true;
        changesMade = true;
        break;
      }
    }
    if (!found) {
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
  const ListTodosSchema = z.object({
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

  server.tool(
    "list_todos",
    ListTodosSchema.shape,
    async (rawArgs: unknown) => {
      const { status = "todo", search, limit = 50, offset = 0 } =
        ListTodosSchema
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
    },
  );

  // Tool: add_todo
  server.tool(
    "add_todo",
    AddTodoSchema.shape,
    (rawArgs: unknown) => addTodoHandler(backend, rawArgs),
  );

  // Tool: edit_todo
  const EditTodoSchema = z.object({
    edits: z.array(z.object({
      hash: z.string().describe("Hash of the todo to edit"),
      text: z.string().describe("New text for the todo"),
    })).describe("An array of todo edits"),
  });

  server.tool(
    "edit_todo",
    EditTodoSchema.shape,
    (rawArgs: unknown) => editTodoHandler(backend, rawArgs),
  );

  // Tool: set_todo_status
  const SetTodoStatusSchema = z.object({
    hash: z.string().describe("Hash of the todo to update"),
    status: z.enum(["done", "todo"]).describe(
      "New status for the todo ('done' or 'todo')",
    ),
  });

  server.tool(
    "set_todo_status",
    SetTodoStatusSchema.shape,
    async (rawArgs: unknown) => {
      const { hash, status } = SetTodoStatusSchema.parse(rawArgs);
      const todos = await backend.load();
      let foundIndex = -1;
      for (let i = 0; i < todos.length; i++) {
        if ((await todos[i].getHash()) === hash) {
          foundIndex = i;
          break;
        }
      }

      if (foundIndex === -1) {
        return {
          isError: true,
          content: [{ type: "text", text: "Todo not found (file modified?)" }],
        };
      }
      const todo = todos[foundIndex];
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
    },
  );

  return server;
}

async function main() {
  let config: TodoTxtMcpConfig;
  try {
    config = await loadConfig();
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error("❌ Configuration Error in todo.txt-mcp-config.json:");
      error.issues.forEach((issue) => {
        console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
      });
      Deno.exit(1);
    } else if (error instanceof SyntaxError) {
      console.error(
        "❌ Configuration Error: todo.txt-mcp-config.json is not valid JSON.",
      );
      console.error(`  ${error.message}`);
      Deno.exit(1);
    }
    throw error;
  }
  const backend = createBackend(config);
  const server = createTodoMcpServer(backend);

  // Start the server
  const app = express();
  app.use(cors());

  app.post("/mcp", async (req: Request, res: Response) => {
    // Create a new transport for each request to prevent request ID collisions
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      transport.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const port = parseInt(Deno.env.get("PORT") || "3000");
  app.listen(port, () => {
    console.log(`todo.txt-mcp Server running on http://localhost:${port}`);
    console.log(`MCP Endpoint: http://localhost:${port}/mcp`);
  });
}

if (import.meta.main) {
  main();
}
