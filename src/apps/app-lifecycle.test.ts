import { describe, expect, it, vi } from "vitest";
import { createInFlightTracker, requireNoPendingMigrations, runWorkerIteration } from "./app-lifecycle.js";

describe("app lifecycle", () => {
  it("rejects pending migrations and missing production character", async () => {
    await expect(Promise.resolve().then(() => requireNoPendingMigrations([{ state: "pending" }]))).rejects.toThrow(
      "pending migrations",
    );
    await expect(
      Promise.resolve().then(() => requireNoPendingMigrations([{ state: "applied" }], null)),
    ).rejects.toThrow("production character");
  });
  it("drains in-flight work before close", async () => {
    const tracker = createInFlightTracker();
    let released = false;
    const pending = tracker.track(
      new Promise<void>((resolve) =>
        setTimeout(() => {
          released = true;
          resolve();
        }, 5),
      ),
    );
    await tracker.drain();
    expect(released).toBe(true);
    await pending;
  });
  it("tracks rejected promises without an unhandled derived rejection", async () => {
    const tracker = createInFlightTracker();
    const rejected = tracker.track(Promise.reject(new Error("expected")));
    await tracker.drain();
    await expect(rejected).rejects.toThrow("expected");
    expect(tracker.size).toBe(0);
  });
  it("applies failure policy when worker handler fails", async () => {
    const fail = vi.fn().mockResolvedValue(undefined);
    const queue = {
      claim: vi.fn().mockResolvedValue({
        id: "j",
        eventId: "e",
        attempts: 1,
        maxAttempts: 3,
        leaseToken: "l",
        kind: "mention_response",
        leasedUntil: new Date(),
      }),
    };
    await expect(
      runWorkerIteration(
        queue,
        "w",
        new Date(),
        async () => {
          throw new Error("boom");
        },
        async (job, error) => fail(job, error),
      ),
    ).rejects.toThrow("boom");
    expect(fail).toHaveBeenCalled();
  });
});
