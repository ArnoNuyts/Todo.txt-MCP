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

export interface ReadinessProbeOptions {
  /**
   * How long a successful result may be reused before probing again.
   * Default: 0 (no caching). Failures are never cached.
   */
  cacheMs?: number;
  /** Clock used for cache expiry; injectable for tests. Default: `Date.now`. */
  now?: () => number;
}

interface CachedResult {
  result: ReadinessResult;
  /** Epoch milliseconds at which the cached result stops being reusable. */
  expiresAt: number;
}

/**
 * Builds a single-flight readiness probe. Timed-out probes keep the underlying
 * load running once; later probes reuse the same result until that load
 * settles instead of starting another one.
 *
 * A successful result can optionally be reused for `cacheMs`, so a probe flood
 * does not reparse the todo file after each probe settles. Failures are never
 * cached: an unhealthy backend is re-checked on the next probe.
 */
export function createReadinessProbe(
  backend: TodoBackend,
  timeoutMs: number,
  options: ReadinessProbeOptions = {},
): () => Promise<ReadinessResult> {
  const cacheMs = Math.max(0, options.cacheMs ?? 0);
  const now = options.now ?? Date.now;
  let inFlight: Promise<ReadinessResult> | undefined;
  let cached: CachedResult | undefined;

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
    if (cacheMs > 0 && cached !== undefined) {
      if (now() < cached.expiresAt) {
        return Promise.resolve(cached.result);
      }
      cached = undefined;
    }

    if (inFlight === undefined) {
      const current = run();
      inFlight = current.result;
      void current.backendSettled.then(() => {
        if (inFlight === current.result) {
          inFlight = undefined;
        }
      });
      if (cacheMs > 0) {
        void current.result.then((result) => {
          if (result.ready) {
            cached = { result, expiresAt: now() + cacheMs };
          }
        });
      }
    }
    return inFlight;
  };
}
