import type { ClaimedJob, JobQueue } from "./job-queue.js";

export const JOB_LEASE_MS = 60_000;
export async function runOneJob(
  queue: Pick<JobQueue, "claim">,
  workerId: string,
  now: Date,
  handler: (job: ClaimedJob) => Promise<void>,
  onError?: (job: ClaimedJob, error: unknown) => Promise<void>,
): Promise<boolean> {
  const job = await queue.claim(workerId, now, JOB_LEASE_MS);
  if (!job) return false;
  try {
    await handler(job);
  } catch (error) {
    await onError?.(job, error);
    throw error;
  }
  return true;
}
