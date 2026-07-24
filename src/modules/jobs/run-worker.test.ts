import { describe, expect, it, vi } from "vitest";
import { runOneJob } from "./run-worker.js";
import { JOB_LEASE_MS } from "./run-worker.js";

describe("runOneJob", () => {
  it("claims with a lease and handles the claimed job", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const job = {
      id: "j1",
      kind: "mention_response" as const,
      eventId: "e1",
      attempts: 1,
      maxAttempts: 3,
      leasedUntil: now,
      leaseToken: "l1",
    };
    const queue = { claim: vi.fn().mockResolvedValue(job) };
    const handler = vi.fn().mockResolvedValue(undefined);
    await expect(runOneJob(queue, "worker-1", now, handler)).resolves.toBe(true);
    expect(handler).toHaveBeenCalledWith(job);
    expect(queue.claim).toHaveBeenCalledWith("worker-1", now, JOB_LEASE_MS);
  });

  it("returns false when no job is available", async () => {
    const queue = { claim: vi.fn().mockResolvedValue(null) };
    await expect(runOneJob(queue, "worker-1", new Date(), vi.fn())).resolves.toBe(false);
  });
});
