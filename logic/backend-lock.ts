import type { TodoBackend } from "./backend.ts";

/**
 * Tail of the pending operation chain for each backend.
 *
 * A `WeakMap` keeps the lock scoped to the backend instance and lets the
 * entry be garbage collected together with the backend.
 */
const backendQueues = new WeakMap<TodoBackend, Promise<unknown>>();

/**
 * Serializes work that performs a load -> mutate -> save cycle on the same
 * backend.
 *
 * Concurrent callers are queued in invocation order. A rejected operation does
 * not prevent the following operations from running.
 */
export function withBackendLock<T>(
  backend: TodoBackend,
  work: () => Promise<T>,
): Promise<T> {
  const previous = backendQueues.get(backend) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(work);

  backendQueues.set(backend, run);
  run
    .finally(() => {
      if (backendQueues.get(backend) === run) {
        backendQueues.delete(backend);
      }
    })
    .catch(() => {
      // The rejection is surfaced through `run` itself; this catch only keeps
      // the cleanup promise from becoming an unhandled rejection.
    });

  return run;
}
