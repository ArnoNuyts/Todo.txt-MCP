import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { isNotFoundError } from "./fs-errors.ts";

const LocalConfig = z.object({
  backend: z.literal("local"),
  local: z.object({
    filename: z.string().default("todo.txt"),
  }).default({ filename: "todo.txt" }),
});

const WebDavConfig = z.object({
  backend: z.literal("webdav"),
  webdav: z.object({
    url: z.string(),
    username: z.string().optional(),
    password: z.string().optional(),
  }),
});

export const ConfigSchema = z.discriminatedUnion("backend", [
  LocalConfig,
  WebDavConfig,
]);

export type TodoTxtMcpConfig = z.infer<typeof ConfigSchema>;

export interface LoadConfigOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export async function loadConfig(
  options: LoadConfigOptions = {},
): Promise<TodoTxtMcpConfig> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  type ConfigMap = { [key: string]: ConfigMap | string | undefined };
  let config: ConfigMap = {};

  // 1. Try to load from file
  try {
    const text = await readFile(
      join(cwd, "todo.txt-mcp-config.json"),
      "utf8",
    );
    config = JSON.parse(text);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
    console.log(
      "Config file not found, using defaults and environment variables.",
    );
  }

  // 2. Override with Environment Variables
  const envMapping: Record<string, string> = {
    "TODOTXT_MCP_BACKEND": "backend",
    "TODOTXT_MCP_LOCAL_FILENAME": "local.filename",
    "TODOTXT_MCP_WEBDAV_URL": "webdav.url",
    "TODOTXT_MCP_WEBDAV_USERNAME": "webdav.username",
    "TODOTXT_MCP_WEBDAV_PASSWORD": "webdav.password",
  };

  for (const [envVar, path] of Object.entries(envMapping)) {
    const value = env[envVar];
    if (value !== undefined) {
      const parts = path.split(".");
      let current: ConfigMap = config;
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (typeof current[part] !== "object" || current[part] === null) {
          current[part] = {};
        }
        current = current[part] as ConfigMap;
      }
      current[parts[parts.length - 1]] = value;
    }
  }

  // Default to local if nothing specified
  if (!config.backend) {
    config.backend = "local";
  }

  // 3. Validate
  return ConfigSchema.parse(config);
}
