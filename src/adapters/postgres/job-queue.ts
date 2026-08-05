import type { Sql } from "postgres";
import type { ClaimedJob, JobQueue } from "../../modules/jobs/job-queue.js";

function assertDate(value: Date, name: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(`${name} must be a valid date`);
}

function assertLeaseToken(value: string): void {
  if (!value.trim()) throw new Error("Lease token is required");
}

export class PostgresJobQueue implements JobQueue {
  public constructor(private readonly sql: Sql) {}

  public async claim(workerId: string, now: Date, leaseMs: number): Promise<ClaimedJob | null> {
    if (!workerId.trim()) throw new Error("Worker ID is required");
    assertDate(now, "now");
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("Lease duration must be finite and positive");
    const leasedUntil = new Date(now.getTime() + leaseMs);
    assertDate(leasedUntil, "leasedUntil");
    return this.sql.begin(async (transaction) => {
      const mode = await transaction<{ mode: string }[]>`select mode from system_state where singleton for share`;
      if (!mode[0]) throw new Error("System state singleton is missing");
      if (mode[0].mode !== "running") return null;
      const expirationError = "lease_expired_at_maximum_attempts";
      const expiredJobs = await transaction<Array<{ id: string; trigger_event_id: string | null }>>`
        select id, trigger_event_id from jobs
        where state = 'running' and leased_until < ${now} and attempts >= max_attempts
        for update
      `;
      for (const job of expiredJobs) {
        await transaction`
          update jobs set state = 'failed', last_error = ${expirationError}, leased_until = null, lease_owner = null, lease_token = null, updated_at = ${now}
          where id = ${job.id} and state = 'running' and leased_until < ${now} and attempts >= max_attempts
        `;
        const runs = await transaction<Array<{ id: string }>>`
          update decision_runs set state = 'failed', error = ${expirationError}, finished_at = ${now}
          where job_id = ${job.id} and state = 'running'
          returning id
        `;
        await transaction`
          insert into audit_entries (id, category, event_id, job_id, run_id, summary, created_at)
          values (gen_random_uuid(), 'decision.failed', ${job.trigger_event_id}, ${job.id}, ${runs[0]?.id ?? null}, ${transaction.json({ error: expirationError })}, ${now})
        `;
      }
      const rows = await transaction<ClaimedJob[]>`
        with candidate as (
          select j.id from jobs j
          where j.attempts < j.max_attempts
            and (j.state = 'queued' and j.available_at <= ${now} or j.state = 'running' and j.leased_until < ${now})
          order by j.priority desc, j.created_at
          for update skip locked limit 1
        )
        update jobs j set state = 'running', lease_owner = ${workerId}, lease_token = gen_random_uuid(), leased_until = ${leasedUntil}, attempts = j.attempts + 1, updated_at = ${now}
        from candidate c where j.id = c.id
        returning j.id, j.kind, j.guild_id as "guildId", j.channel_id as "channelId", j.thread_id as "threadId",
          j.trigger_event_id as "triggerEventId", j.first_triggered_at as "firstTriggeredAt",
          j.attempts, j.max_attempts as "maxAttempts", j.leased_until as "leasedUntil", j.lease_token as "leaseToken"
      `;
      return rows[0] ?? null;
    });
  }

  public async succeed(jobId: string, leaseToken: string, now: Date): Promise<void> {
    assertLeaseToken(leaseToken);
    assertDate(now, "now");
    const rows = await this.sql<{ id: string }[]>`
      update jobs set state = 'succeeded', leased_until = null, lease_owner = null, lease_token = null, updated_at = ${now}
      where id = ${jobId} and state = 'running' and lease_token = ${leaseToken} and leased_until > ${now}
      returning id
    `;
    if (!rows[0]) throw new Error("Job lease lost");
  }

  public async fail(jobId: string, leaseToken: string, error: string, retryable: boolean, now: Date): Promise<void> {
    assertLeaseToken(leaseToken);
    assertDate(now, "now");
    const rows = await this.sql<{ id: string }[]>`
      update jobs set state = case when ${retryable} and attempts < max_attempts then 'queued' else 'failed' end,
        available_at = case when ${retryable} and attempts < max_attempts then ${new Date(now.getTime() + 1000)} else available_at end,
        last_error = ${error.slice(0, 2000)}, leased_until = null, lease_owner = null, lease_token = null, updated_at = ${now}
      where id = ${jobId} and state = 'running' and lease_token = ${leaseToken} and leased_until > ${now}
      returning id
    `;
    if (!rows[0]) throw new Error("Job lease lost");
  }
}
