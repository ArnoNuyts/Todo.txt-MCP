import { describe, expect, it } from "vitest";
import { createOperationTracker } from "../logic/operation-tracker.ts";

describe("operation tracker", () => {
  it("counts running work and resolves idle afterwards", async () => {
    const tracker = createOperationTracker();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const running = tracker.run(async () => {
      await gate;
      return "done";
    });

    expect(tracker.active()).toBe(1);
    let idle = false;
    const waiting = tracker.idle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);

    release();
    await expect(running).resolves.toBe("done");
    await waiting;
    expect(tracker.active()).toBe(0);
    expect(idle).toBe(true);
  });

  it("resolves idle immediately when nothing is running", async () => {
    const tracker = createOperationTracker();
    await expect(tracker.idle()).resolves.toBeUndefined();
  });

  it("waits for every operation in a batch", async () => {
    const tracker = createOperationTracker();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = tracker.run(() => gate);
    const second = tracker.run(() => gate);
    expect(tracker.active()).toBe(2);

    const waiting = tracker.idle();
    release();
    await Promise.all([first, second, waiting]);
    expect(tracker.active()).toBe(0);
  });

  it("releases the count when work rejects", async () => {
    const tracker = createOperationTracker();
    await expect(
      tracker.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(tracker.active()).toBe(0);
    await expect(tracker.idle()).resolves.toBeUndefined();
  });
});
