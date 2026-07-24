import type { MigrationStatus } from "../adapters/postgres/migrations.js";
import type { ClaimedJob, JobQueue } from "../modules/jobs/job-queue.js";
import { runOneJob } from "../modules/jobs/run-worker.js";

export function requireNoPendingMigrations(statuses: Pick<MigrationStatus, "state">[], production?: unknown): void {
  if (statuses.some((status) => status.state === "pending")) throw new Error("pending migrations");
  if (arguments.length > 1 && production == null) throw new Error("production character is required");
}
export function createInFlightTracker() {
  const pending = new Set<Promise<unknown>>();
  return {
    track<T>(promise: Promise<T>): Promise<T> {
      pending.add(promise);
      void promise.then(
        () => {
          pending.delete(promise);
        },
        () => {
          pending.delete(promise);
        },
      );
      return promise;
    },
    async drain(): Promise<void> {
      await Promise.allSettled(pending);
    },
    get size() {
      return pending.size;
    },
  };
}
export async function runWorkerIteration(
  queue: Pick<JobQueue, "claim">,
  workerId: string,
  now: Date,
  handler: (job: ClaimedJob) => Promise<void>,
  failure: (job: ClaimedJob, error: unknown) => Promise<void>,
): Promise<boolean> {
  return runOneJob(queue, workerId, now, handler, failure);
}
