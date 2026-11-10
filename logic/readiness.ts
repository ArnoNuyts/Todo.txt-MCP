import type { TodoBackend } from "./backend.ts";
import { serializeTodoContent } from "./content.ts";

export interface ReadinessResult {
  ready: boolean;
  /** Server-side only; never sent to the client. */
  reason?: string;
}

interface ProbeRun {
  result: Promise<ReadinessResult>;
  /** Settles only when the backend work finishes, not when the timeout wins. */
  backendSettled: Promise<void>;
}

/**
 * Builds a single-flight readiness probe. Timed-out probes keep the underlying
 * load running once; later probes reuse the same result until that load
 * settles instead of starting another one.
 */
export function createReadinessProbe(
  backend: TodoBackend,
  timeoutMs: number,
): () => Promise<ReadinessResult> {
  let inFlight: Promise<ReadinessResult> | undefined;

  const run = (): ProbeRun => {
    let timer: NodeJS.Timeout | undefined;
    const work = (async (): Promise<ReadinessResult> => {
      const todos = await backend.load();
      serializeTodoContent(todos);
      return { ready: true };
    })().catch((error: unknown) => ({
      ready: false,
      reason: error instanceof Error ? error.message : String(error),
    }));

    const timeout = new Promise<ReadinessResult>((resolve) => {
      timer = setTimeout(() => {
        resolve({ ready: false, reason: "readiness timeout" });
      }, Math.max(1, timeoutMs));
      timer.unref();
    });

    const result = Promise.race([work, timeout]).finally(() => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    });
    const backendSettled = work.then(
      () => undefined,
      () => undefined,
    );
    return { result, backendSettled };
  };

  return () => {
    if (inFlight === undefined) {
      const current = run();
      inFlight = current.result;
      void current.backendSettled.then(() => {
        if (inFlight === current.result) {
          inFlight = undefined;
        }
      });
    }
    return inFlight;
  };
}
