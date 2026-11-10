import type { TodoBackend } from "./backend.ts";
import { serializeTodoContent } from "./content.ts";

export interface ReadinessResult {
  ready: boolean;
  /** Server-side only; never sent to the client. */
  reason?: string;
}

/**
 * Builds a single-flight readiness probe. Timed-out probes keep the underlying
 * load running once; later probes reuse it instead of starting another load.
 */
export function createReadinessProbe(
  backend: TodoBackend,
  timeoutMs: number,
): () => Promise<ReadinessResult> {
  let inFlight: Promise<ReadinessResult> | undefined;

  const run = async (): Promise<ReadinessResult> => {
    let timer: NodeJS.Timeout | undefined;
    const work = (async () => {
      const todos = await backend.load();
      serializeTodoContent(todos);
      return { ready: true } as const;
    })().catch((error: unknown) => ({
      ready: false as const,
      reason: error instanceof Error ? error.message : String(error),
    }));

    const timeout = new Promise<ReadinessResult>((resolve) => {
      timer = setTimeout(() => {
        resolve({ ready: false, reason: "readiness timeout" });
      }, Math.max(1, timeoutMs));
      timer.unref();
    });

    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  };

  return () => {
    if (inFlight === undefined) {
      inFlight = run().finally(() => {
        inFlight = undefined;
      });
    }
    return inFlight;
  };
}
