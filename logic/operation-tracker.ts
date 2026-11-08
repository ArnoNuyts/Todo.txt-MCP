/**
 * Tracks in-flight MCP operations so a transport can stop accepting new work
 * and then wait for running handlers before the process exits.
 *
 * This matters for the stdio transport: a tool call may be inside a
 * `load -> mutate -> save` cycle that owns the advisory lock file. Letting the
 * process die mid-write would leave the lock (and a temp file) behind.
 */
export interface OperationTracker {
  /** Runs `work` and resolves when it settles. */
  run<T>(work: () => T | Promise<T>): Promise<T>;
  /** Resolves once no operation is running. */
  idle(): Promise<void>;
  /** Number of currently running operations. */
  active(): number;
}

export function createOperationTracker(): OperationTracker {
  let running = 0;
  let waiters: Array<() => void> = [];

  return {
    async run(work) {
      running += 1;
      try {
        return await work();
      } finally {
        running -= 1;
        if (running === 0) {
          const pending = waiters;
          waiters = [];
          for (const resolve of pending) {
            resolve();
          }
        }
      }
    },
    idle() {
      if (running === 0) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },
    active: () => running,
  };
}
