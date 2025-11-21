import { z } from "npm:zod@3.21.4";

const LocalConfig = z.object({
  backend: z.literal("local"),
  local: z.object({
    filename: z.string().default("todo.txt"),
  }).default({}),
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

export type TodoTuiConfig = z.infer<typeof ConfigSchema>;

export async function loadConfig(): Promise<TodoTuiConfig> {
  let config: Record<string, any> = {};

  // 1. Try to load from file
  try {
    const text = await Deno.readTextFile("todotui-config.json");
    config = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
    console.log("Config file not found, using defaults and environment variables.");
  }

  // 2. Override with Environment Variables
  const envMapping: Record<string, string> = {
    "TODOTUI_BACKEND": "backend",
    "TODOTUI_LOCAL_FILENAME": "local.filename",
    "TODOTUI_WEBDAV_URL": "webdav.url",
    "TODOTUI_WEBDAV_USERNAME": "webdav.username",
    "TODOTUI_WEBDAV_PASSWORD": "webdav.password",
  };

  for (const [envVar, path] of Object.entries(envMapping)) {
    const value = Deno.env.get(envVar);
    if (value !== undefined) {
      const parts = path.split(".");
      let current = config;
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (!current[part]) current[part] = {};
        current = current[part];
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
