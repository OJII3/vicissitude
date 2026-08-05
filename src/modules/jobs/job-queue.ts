export interface ClaimedJob {
  id: string;
  kind: "conversation_evaluate";
  guildId: string;
  channelId: string;
  threadId: string | null;
  triggerEventId: string | null;
  firstTriggeredAt: Date;
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
