import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createPostgresClient } from "../../../src/adapters/postgres/client.js";
import { runMigrations } from "../../../src/adapters/postgres/migrations.js";
import { PostgresJobQueue } from "../../../src/adapters/postgres/job-queue.js";
import { PostgresDecisionEffectStore } from "../../../src/adapters/postgres/decision-effect-store.js";
import { PostgresSystemControlRepository } from "../../../src/adapters/postgres/system-control-repository.js";

const eventId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const now = new Date("2026-01-02T03:04:05.000Z");
let sql: Sql;

async function insertJob(
  id: string,
  event: string,
  values: {
    priority: number;
    createdAt: Date;
    availableAt?: Date;
    attempts?: number;
    maxAttempts?: number;
    state?: string;
  },
) {
  await sql`insert into events (id, schema_version, source, external_event_id, external_version, kind, visibility, guild_id, channel_id, actor_id, actor_kind, occurred_at, received_at, content, expires_at) values (${event}, 1, 'discord', ${event}, '1', 'message.created', 'mention_only', 'g', ${event}, 'a', 'human', ${now}, ${now}, ${sql.json({ text: event })}, ${new Date("2026-02-01T00:00:00Z")})`;
  await sql`insert into jobs (id, kind, guild_id, channel_id, thread_id, trigger_event_id, priority, state, available_at, first_triggered_at, attempts, max_attempts, created_at, updated_at) values (${id}, 'conversation_evaluate', 'g', ${event}, null, ${event}, ${values.priority}, ${values.state ?? "queued"}, ${values.availableAt ?? now}, ${values.createdAt}, ${values.attempts ?? 0}, ${values.maxAttempts ?? 3}, ${values.createdAt}, ${now})`;
}

beforeAll(async () => {
  sql = createPostgresClient(process.env.TEST_DATABASE_URL!);
  await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
    actor: "test-bootstrap",
    backupConfirmedAt: new Date(),
  });
});

beforeEach(async () => {
  await sql`truncate audit_entries, effects, model_calls, run_input_events, decision_runs, jobs, conversation_cursors, actor_states, events cascade`;
  await sql`update system_state set mode = 'running', updated_at = ${now}, updated_by = 'test', reason = 'reset'`;
  await sql`insert into events (id, schema_version, source, external_event_id, external_version, kind, visibility, guild_id, channel_id, actor_id, actor_kind, occurred_at, received_at, content, expires_at) values (${eventId}, 1, 'discord', 'external', '1', 'message.created', 'mention_only', 'g', 'c', 'a', 'human', ${now}, ${now}, ${sql.json({ text: "hi" })}, ${new Date("2026-02-01T00:00:00Z")})`;
  await sql`insert into jobs (id, kind, guild_id, channel_id, thread_id, trigger_event_id, priority, state, available_at, first_triggered_at, attempts, max_attempts, created_at, updated_at) values (${jobId}, 'conversation_evaluate', 'g', 'c', null, ${eventId}, 10, 'queued', ${now}, ${now}, 0, 3, ${now}, ${now})`;
});

afterAll(async () => sql.end());

describe("PostgresJobQueue", () => {
  it("atomically gives one queued job to concurrent claimers", async () => {
    const a = new PostgresJobQueue(sql);
    const [first, second] = await Promise.all([a.claim("worker-a", now, 60_000), a.claim("worker-b", now, 60_000)]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(first ?? second).toMatchObject({
      id: jobId,
      kind: "conversation_evaluate",
      guildId: "g",
      channelId: "c",
      threadId: null,
      triggerEventId: eventId,
      firstTriggeredAt: now,
      attempts: 1,
      maxAttempts: 3,
    });
    expect((first ?? second)?.leaseToken).toEqual(expect.any(String));
  });

  it("claims eligible jobs by priority then creation time and skips future or exhausted jobs", async () => {
    await sql`delete from jobs where id = ${jobId}`;
    await sql`delete from events where id = ${eventId}`;
    await insertJob("33333333-3333-4333-8333-333333333333", "33333333-3333-4333-8333-333333333333", {
      priority: 1,
      createdAt: new Date(now.getTime() - 1000),
    });
    await insertJob("44444444-4444-4444-8444-444444444444", "44444444-4444-4444-8444-444444444444", {
      priority: 10,
      createdAt: new Date(now.getTime() + 1000),
    });
    await insertJob("55555555-5555-4555-8555-555555555555", "55555555-5555-4555-8555-555555555555", {
      priority: 10,
      createdAt: now,
    });
    await insertJob("66666666-6666-4666-8666-666666666666", "66666666-6666-4666-8666-666666666666", {
      priority: 100,
      createdAt: now,
      availableAt: new Date(now.getTime() + 1000),
    });
    await insertJob("77777777-7777-4777-8777-777777777777", "77777777-7777-4777-8777-777777777777", {
      priority: 100,
      createdAt: now,
      attempts: 3,
      maxAttempts: 3,
    });
    const queue = new PostgresJobQueue(sql);
    const first = await queue.claim("worker", now, 60_000);
    expect(first).toMatchObject({
      id: "55555555-5555-4555-8555-555555555555",
    });
    await queue.succeed(first!.id, first!.leaseToken, now);
    const second = await queue.claim("worker", now, 60_000);
    expect(second).toMatchObject({
      id: "44444444-4444-4444-8444-444444444444",
    });
  });

  it.each(["draining", "stopped"])("does not claim while system is %s", async (mode) => {
    await sql`update system_state set mode = ${mode}`;
    await expect(new PostgresJobQueue(sql).claim("worker", now, 60_000)).resolves.toBeNull();
  });

  it("uses the committed system mode as a transaction barrier", async () => {
    const controlSql = createPostgresClient(process.env.TEST_DATABASE_URL!);
    const queueSql = createPostgresClient(process.env.TEST_DATABASE_URL!);
    try {
      const control = new PostgresSystemControlRepository(controlSql);
      await control.setMode("stopped", "operator", "stop first", now);
      await expect(new PostgresJobQueue(queueSql).claim("worker", now, 60_000)).resolves.toBeNull();
      await control.setMode("running", "operator", "resume", now);
      await expect(new PostgresJobQueue(queueSql).claim("worker", now, 60_000)).resolves.toMatchObject({ id: jobId });
    } finally {
      await controlSql.end();
      await queueSql.end();
    }
  });

  it("holds the shared mode lock until claim commits before setMode can commit", async () => {
    const controlSql = createPostgresClient(process.env.TEST_DATABASE_URL!);
    const queueSql = createPostgresClient(process.env.TEST_DATABASE_URL!);
    let releaseBlocker!: () => void;
    const blockerReleased = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    try {
      await sql.unsafe(
        `create function test_claim_barrier() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(735102); return new; end $$`,
      );
      await sql.unsafe(
        "create trigger test_claim_barrier before update on jobs for each row execute function test_claim_barrier()",
      );
      const blocker = controlSql.begin(async (transaction) => {
        await transaction`select pg_advisory_xact_lock(735102)`;
        await blockerReleased;
      });
      for (;;) {
        const locks = await sql<
          { granted: boolean }[]
        >`select granted from pg_locks where locktype = 'advisory' and classid = 0 and objid = 735102`;
        if (locks.some((lock) => lock.granted)) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const queuePid = (await queueSql<{ pid: number }[]>`select pg_backend_pid() as pid`)[0]!.pid;
      const claim = new PostgresJobQueue(queueSql).claim("worker", now, 60_000);
      for (;;) {
        const locks = await sql<{ mode: string; granted: boolean }[]>`
          select mode, granted from pg_locks
          where pid = ${queuePid} and relation = 'system_state'::regclass
        `;
        const hasSharedLock = locks.some((lock) => lock.granted && lock.mode === "RowShareLock");
        const waitsForJobUpdate = (
          await sql<
            { granted: boolean }[]
          >`select granted from pg_locks where pid = ${queuePid} and locktype = 'advisory' and objid = 735102`
        ).some((lock) => !lock.granted);
        if (hasSharedLock && waitsForJobUpdate) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const modeChange = new PostgresSystemControlRepository(controlSql).setMode("stopped", "operator", "stop", now);
      releaseBlocker();
      await expect(claim).resolves.toMatchObject({ id: jobId });
      await expect(modeChange).resolves.toMatchObject({ mode: "stopped" });
      await blocker;
    } finally {
      releaseBlocker();
      await sql`drop trigger if exists test_claim_barrier on jobs`;
      await sql`drop function if exists test_claim_barrier()`;
      await controlSql.end();
      await queueSql.end();
    }
  });

  it("serializes exhausted cleanup behind a late decision run start", async () => {
    const controlSql = createPostgresClient(process.env.TEST_DATABASE_URL!);
    const storeSql = createPostgresClient(process.env.TEST_DATABASE_URL!);
    const queueSql = createPostgresClient(process.env.TEST_DATABASE_URL!);
    const advisoryKey = 735319;
    let releaseBlocker!: () => void;
    const blockerReleased = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const leaseToken = "00000000-0000-4000-8000-000000000099";
    const expiredNow = new Date(now.getTime() + 2);
    let start: Promise<{ runId: string; state: "running" | "succeeded" | "failed" }> | undefined;
    let cleanup: Promise<unknown> | undefined;
    let blocker: Promise<unknown> | undefined;
    try {
      await sql`update jobs set state = 'running', attempts = max_attempts, lease_owner = 'worker', lease_token = ${leaseToken}, leased_until = ${new Date(now.getTime() + 1)}`;
      await sql.unsafe(
        `create function test_late_run_start() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(${advisoryKey}); return new; end $$`,
      );
      await sql.unsafe(
        "create trigger test_late_run_start before insert on decision_runs for each row execute function test_late_run_start()",
      );
      blocker = controlSql.begin(async (transaction) => {
        await transaction`select pg_advisory_xact_lock(${advisoryKey})`;
        await blockerReleased;
      });
      for (;;) {
        const locks = await sql<
          { granted: boolean }[]
        >`select granted from pg_locks where locktype = 'advisory' and classid = 0 and objid = ${advisoryKey}`;
        if (locks.some((lock) => lock.granted)) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const storePid = (await storeSql<{ pid: number }[]>`select pg_backend_pid() as pid`)[0]!.pid;
      start = new PostgresDecisionEffectStore(storeSql).startOrLoadRun({
        jobId,
        triggerEventId: eventId,
        leaseToken,
        characterId: "character",
        characterVersion: 1,
        routeVersion: "route",
        now,
      });
      for (;;) {
        const waiting = await sql<
          { granted: boolean }[]
        >`select granted from pg_locks where pid = ${storePid} and locktype = 'advisory' and classid = 0 and objid = ${advisoryKey}`;
        if (waiting.some((lock) => !lock.granted)) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const queuePid = (await queueSql<{ pid: number }[]>`select pg_backend_pid() as pid`)[0]!.pid;
      cleanup = new PostgresJobQueue(queueSql).claim("cleanup", expiredNow, 60_000);
      for (;;) {
        const waiting = await sql<{ locktype: string; granted: boolean }[]>`
          select locktype, granted from pg_locks
          where pid = ${queuePid}
            and (relation = 'jobs'::regclass or locktype in ('tuple', 'transactionid'))
        `;
        if (waiting.some((lock) => !lock.granted)) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      releaseBlocker();
      const run = await start;
      await expect(cleanup).resolves.toBeNull();
      await blocker;
      await expect(sql`select state from jobs where id = ${jobId}`).resolves.toEqual([{ state: "failed" }]);
      await expect(sql`select id, state, finished_at from decision_runs where id = ${run.runId}`).resolves.toEqual([
        { id: run.runId, state: "failed", finished_at: expiredNow },
      ]);
      await expect(
        sql`select category, event_id, job_id, run_id from audit_entries where category = 'decision.failed'`,
      ).resolves.toEqual([{ category: "decision.failed", event_id: eventId, job_id: jobId, run_id: run.runId }]);
    } finally {
      releaseBlocker();
      await Promise.allSettled([start, cleanup, blocker]);
      await sql`drop trigger if exists test_late_run_start on decision_runs`;
      await sql`drop function if exists test_late_run_start()`;
      await controlSql.end();
      await storeSql.end();
      await queueSql.end();
    }
  });

  it("reclaims an expired lease as the next attempt", async () => {
    await sql`update jobs set state = 'running', lease_owner = 'old', leased_until = ${new Date(now.getTime() - 1)}, attempts = 1`;
    await expect(new PostgresJobQueue(sql).claim("worker", now, 60_000)).resolves.toMatchObject({ attempts: 2 });
  });

  it("succeeds and handles retryable and terminal failures", async () => {
    const queue = new PostgresJobQueue(sql);
    const first = (await queue.claim("worker", now, 60_000))!;
    await queue.fail(jobId, first.leaseToken, "x".repeat(2100), true, now);
    await expect(sql`select state, attempts, last_error, leased_until, lease_owner from jobs`).resolves.toMatchObject([
      { state: "queued", attempts: 1, leased_until: null, lease_owner: null, last_error: "x".repeat(2000) },
    ]);
    await expect(queue.claim("worker", new Date(now.getTime() + 999), 60_000)).resolves.toBeNull();
    const second = (await queue.claim("worker", new Date(now.getTime() + 1000), 60_000))!;
    await queue.succeed(jobId, second.leaseToken, new Date(now.getTime() + 1000));
    await expect(sql`select state, leased_until, lease_owner from jobs`).resolves.toEqual([
      { state: "succeeded", leased_until: null, lease_owner: null },
    ]);
  });

  it("fails non-retryable jobs and jobs at their attempt limit", async () => {
    const queue = new PostgresJobQueue(sql);
    const claimed = (await queue.claim("worker", now, 60_000))!;
    await queue.fail(jobId, claimed.leaseToken, "terminal", false, now);
    await expect(sql`select state, leased_until, lease_owner from jobs`).resolves.toEqual([
      { state: "failed", leased_until: null, lease_owner: null },
    ]);
    await sql`update jobs set state = 'running', attempts = max_attempts, lease_owner = 'worker', lease_token = ${claimed.leaseToken}, leased_until = ${new Date(now.getTime() + 1000)}`;
    await queue.fail(jobId, claimed.leaseToken, "limit", true, now);
    await expect(sql`select state, leased_until, lease_owner from jobs`).resolves.toEqual([
      { state: "failed", leased_until: null, lease_owner: null },
    ]);
  });

  it("fences an expired worker after another worker reclaims the job", async () => {
    const queue = new PostgresJobQueue(sql);
    const first = (await queue.claim("worker-a", now, 1))!;
    const second = (await queue.claim("worker-b", new Date(now.getTime() + 2), 60_000))!;
    await expect(queue.succeed(jobId, first.leaseToken, new Date(now.getTime() + 2))).rejects.toThrow(/lease lost/i);
    await expect(queue.fail(jobId, first.leaseToken, "stale", true, new Date(now.getTime() + 2))).rejects.toThrow(
      /lease lost/i,
    );
    await expect(sql`select state, lease_owner, lease_token from jobs`).resolves.toEqual([
      { state: "running", lease_owner: "worker-b", lease_token: second.leaseToken },
    ]);
    await expect(queue.succeed(jobId, second.leaseToken, new Date(now.getTime() + 2))).resolves.toBeUndefined();
  });

  it("rejects expired completion and finalizes an exhausted lease", async () => {
    const queue = new PostgresJobQueue(sql);
    const claimed = (await queue.claim("worker", now, 1))!;
    await expect(queue.succeed(jobId, claimed.leaseToken, new Date(now.getTime() + 2))).rejects.toThrow(/lease lost/i);
    const runId = "33333333-3333-4333-8333-333333333333";
    await sql`insert into decision_runs (id, job_id, event_id, character_id, character_version, model_route_version, state, started_at) values (${runId}, ${jobId}, ${eventId}, 'character', 1, 'route', 'running', ${now})`;
    await sql`update jobs set attempts = max_attempts, leased_until = ${new Date(now.getTime() - 1)}`;
    await expect(queue.claim("worker", now, 60_000)).resolves.toBeNull();
    await expect(
      sql`select state, lease_owner, leased_until, lease_token, last_error from jobs`,
    ).resolves.toMatchObject([
      {
        state: "failed",
        lease_owner: null,
        leased_until: null,
        lease_token: null,
        last_error: expect.stringContaining("expired"),
      },
    ]);
    await expect(sql`select state, finished_at, error from decision_runs where id = ${runId}`).resolves.toEqual([
      { state: "failed", finished_at: now, error: "lease_expired_at_maximum_attempts" },
    ]);
    await expect(
      sql`select category, event_id, job_id, run_id, summary, created_at from audit_entries where category = 'decision.failed'`,
    ).resolves.toEqual([
      {
        category: "decision.failed",
        event_id: eventId,
        job_id: jobId,
        run_id: runId,
        summary: { error: "lease_expired_at_maximum_attempts" },
        created_at: now,
      },
    ]);
    await expect(queue.claim("worker", now, 60_000)).resolves.toBeNull();
    await expect(
      sql`select count(*)::int as count from audit_entries where category = 'decision.failed'`,
    ).resolves.toEqual([{ count: 1 }]);
  });

  it("finalizes an exhausted job without a run and audits it once", async () => {
    const queue = new PostgresJobQueue(sql);
    const claimed = (await queue.claim("worker", now, 1))!;
    await sql`update jobs set attempts = max_attempts, leased_until = ${new Date(now.getTime() - 1)}`;
    await expect(queue.claim("worker", now, 60_000)).resolves.toBeNull();
    await expect(sql`select state from jobs where id = ${jobId}`).resolves.toEqual([{ state: "failed" }]);
    await expect(
      sql`select category, event_id, job_id, run_id, summary, created_at from audit_entries where category = 'decision.failed'`,
    ).resolves.toEqual([
      {
        category: "decision.failed",
        event_id: eventId,
        job_id: jobId,
        run_id: null,
        summary: { error: "lease_expired_at_maximum_attempts" },
        created_at: now,
      },
    ]);
    await expect(queue.claim("worker", now, 60_000)).resolves.toBeNull();
    await expect(
      sql`select count(*)::int as count from audit_entries where category = 'decision.failed'`,
    ).resolves.toEqual([{ count: 1 }]);
    expect(claimed).toBeTruthy();
  });

  it("validates claim and completion inputs", async () => {
    const queue = new PostgresJobQueue(sql);
    await expect(queue.claim(" ", now, 1)).rejects.toThrow();
    await expect(queue.claim("worker", now, 0)).rejects.toThrow();
    await expect(queue.claim("worker", new Date("invalid"), 1)).rejects.toThrow();
    await expect(queue.succeed(jobId, " ", now)).rejects.toThrow();
    await expect(queue.fail(jobId, " ", "error", true, now)).rejects.toThrow();
  });
});

describe("PostgresSystemControlRepository", () => {
  it("changes mode and records an audit entry, validating actor and reason", async () => {
    const repository = new PostgresSystemControlRepository(sql);
    await expect(repository.setMode("draining", "operator", "maintenance", now)).resolves.toEqual({
      mode: "draining",
      updatedAt: now,
      updatedBy: "operator",
      reason: "maintenance",
    });
    await expect(sql`select category, summary, created_at from audit_entries`).resolves.toMatchObject([
      {
        category: "system.mode.changed",
        created_at: now,
        summary: { actor: "operator", reason: "maintenance", before: "running", after: "draining" },
      },
    ]);
    await expect(repository.setMode("running", "", "reason", now)).rejects.toThrow();
    await expect(repository.setMode("running", "operator", "   ", now)).rejects.toThrow();
    await expect(repository.setMode("running", "operator", "reason", new Date("invalid"))).rejects.toThrow();
    await expect(repository.get()).resolves.toMatchObject({ mode: "draining" });
  });
});
