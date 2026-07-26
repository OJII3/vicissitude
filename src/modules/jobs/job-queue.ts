export interface ClaimedJob {
  id: string;
  kind: "mention_response";
  eventId: string;
  attempts: number;
  maxAttempts: number;
  leasedUntil: Date;
  leaseToken: string;
}

export interface JobQueue {
  claim(workerId: string, now: Date, leaseMs: number): Promise<ClaimedJob | null>;
  succeed(jobId: string, leaseToken: string, now: Date): Promise<void>;
  fail(jobId: string, leaseToken: string, error: string, retryable: boolean, now: Date): Promise<void>;
}
