import type { TodoBackend } from "./backend.ts";
import { serializeTodoContent } from "./content.ts";

/**
 * Loads and serializes the todo list within `timeoutMs`. Resolves `false` on
 * failure or timeout; never exposes the error or the file contents.
 */
export async function probeReadiness(
  backend: TodoBackend,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const work = (async () => {
    const todos = await backend.load();
    serializeTodoContent(todos);
    return true;
  })().catch(() => false);

  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(1, timeoutMs));
    timer.unref();
  });

  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
