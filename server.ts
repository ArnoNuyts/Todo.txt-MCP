import { McpServer } from "npm:@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "npm:zod@3.21.4";
import { StreamableHTTPServerTransport } from "npm:@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "npm:express";
import cors from "npm:cors";

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
        config.webdav.password
      );
    case "local":
      return new LocalFileBackend(config.local.filename);
  }
}

async function createTodoServer() {
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
      console.error("❌ Configuration Error: todo.txt-mcp-config.json is not valid JSON.");
      console.error(`  ${error.message}`);
      Deno.exit(1);
    }
    throw error;
  }
  const backend = createBackend(config);

  const server = new McpServer({
    name: "todo.txt-mcp",
    version: "1.0.0",
  });

  // Register a prompt describing the todo.txt format
  server.registerPrompt(
    "todo_format",
    "The todo.txt format includes tags (e.g., @home), contexts (e.g., +project), recurrence rec:+2w (e.g., 'every 2 weeks'), and the 'x' marker indicating a completed task."
  );



  // Tool: list_todos
  server.tool(
    "list_todos",
    {
      status: z.enum(["todo", "done", "all"]).optional().describe("Filter by status: 'todo' (default), 'done', or 'all'"),
      search: z.string().optional().describe("Search query to filter todos by text"),
      limit: z.number().optional().describe("Maximum number of todos to return (default: 50)"),
      offset: z.number().optional().describe("Number of todos to skip (default: 0)"),
    } as any,
    async ({ status = "todo", search, limit = 50, offset = 0 }: { status?: "todo" | "done" | "all"; search?: string; limit?: number; offset?: number }) => {
      const allTodos = await backend.load();
      
      let filteredTodos = allTodos;

      // Filter by status
      if (status !== "all") {
        const targetState = status === "done" ? TodoStateEnum.done : TodoStateEnum.todo;
        filteredTodos = filteredTodos.filter(t => t.state === targetState);
      }

      // Filter by search query
      if (search) {
        const lowerSearch = search.toLowerCase();
        filteredTodos = filteredTodos.filter(t => t.text.toLowerCase().includes(lowerSearch));
      }

      // Apply pagination
      const pagedTodos = filteredTodos.slice(offset, offset + limit);

      const todoStrings = await Promise.all(
        pagedTodos.map(async (todo) => {
          const hash = await todo.getHash();
          return `[${hash}] ${todo.toDisplayString()}`;
        })
      );

      return {
        content: [
          {
            type: "text",
            text: todoStrings.length > 0 ? todoStrings.join("\n") : "No todos found matching criteria.",
          },
        ],
      };
    }
  );

  // Tool: add_todo
  // @ts-ignore: Zod version mismatch with McpServer
  server.tool(
    "add_todo",
    {
      text: z.string().describe("The todo text, supports todo.txt format"),
    } as any,
    async ({ text }: { text: string }) => {
      const todos = await backend.load();
      const newTodo = new Todo(text);
      if (!newTodo.creationDate) {
        newTodo.creationDate = new Date();
      }
      todos.push(newTodo);
      await backend.save(todos);
      return {
        content: [
          {
            type: "text",
            text: `Added todo [${await newTodo.getHash()}]: ${newTodo.toDisplayString()}`,
          },
        ],
      };
    }
  );

  // Tool: edit_todo
  // @ts-ignore: Zod version mismatch with McpServer
  server.tool(
    "edit_todo",
    {
      hash: z.string().describe("Hash of the todo to edit"),
      text: z.string().describe("New text for the todo"),
    } as any,
    async ({ hash, text }: { hash: string; text: string }) => {
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
      todo.setText(text);
      await backend.save(todos);
      return {
        content: [
          {
            type: "text",
            text: `Edited todo [${await todo.getHash()}]: ${todo.toDisplayString()}`,
          },
        ],
      };
    }
  );

  // Tool: set_todo_status
  // @ts-ignore: Zod version mismatch with McpServer
  server.tool(
    "set_todo_status",
    {
      hash: z.string().describe("Hash of the todo to update"),
      status: z.enum(["done", "todo"]).describe("New status for the todo ('done' or 'todo')"),
    } as any,
    async ({ hash, status }: { hash: string; status: "done" | "todo" }) => {
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
      const targetState = status === "done" ? TodoStateEnum.done : TodoStateEnum.todo;

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
            type: "text",
            text: `Set todo [${await todo.getHash()}] status to ${status}: ${todo.toDisplayString()}`,
          },
        ],
      };
    }
  );

  return server;
}

// Global server and transport
const server = await createTodoServer();

// Start the server
const app = express();
app.use(cors());

app.post('/mcp', async (req: any, res: any) => {
    // Create a new transport for each request to prevent request ID collisions
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
    });

    res.on('close', () => {
        transport.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
});

const port = parseInt(Deno.env.get("PORT") || "3000");
app.listen(port,  () => {
  console.log(`todo.txt-mcp Server running on http://localhost:${port}`);
  console.log(`MCP Endpoint: http://localhost:${port}/mcp`);
});


