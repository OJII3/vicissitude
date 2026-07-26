import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createPostgresClient } from "../../../src/adapters/postgres/client.js";
import { runMigrations } from "../../../src/adapters/postgres/migrations.js";
import { PostgresDecisionEffectStore } from "../../../src/adapters/postgres/decision-effect-store.js";

let sql: Sql;
beforeAll(async () => {
  sql = createPostgresClient(process.env.TEST_DATABASE_URL!);
  await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
    actor: "test-bootstrap",
    backupConfirmedAt: new Date(),
  });
});
afterAll(async () => sql.end());
beforeEach(async () => {
  await sql`truncate audit_entries, effects, model_calls, decision_runs, jobs, events cascade`;
});
async function fixture(
  leaseToken = "00000000-0000-4000-8000-000000000001",
  leasedUntil = new Date("2026-07-23T00:01:00Z"),
) {
  const now = new Date("2026-07-23T00:00:00Z");
  const eventId = "00000000-0000-4000-8000-000000000020";
  const jobId = "00000000-0000-4000-8000-000000000021";
  await sql`insert into events (id, schema_version, source, external_event_id, external_version, kind, visibility, guild_id, channel_id, actor_id, actor_kind, occurred_at, received_at, content, expires_at) values (${eventId}, 1, 'discord', 'message-20', '0', 'message.created', 'mention_only', 'g', 'c', 'u', 'human', ${now}, ${now}, ${sql.json({ text: "@bot hi", mentionedBot: true, mentionIds: ["bot"], replyToMessageId: null, attachments: [] })}, ${new Date("2026-08-22T00:00:00Z")})`;
  await sql`insert into jobs (id, kind, event_id, state, available_at, leased_until, lease_owner, lease_token, attempts, max_attempts, created_at, updated_at) values (${jobId}, 'mention_response', ${eventId}, 'running', ${now}, ${leasedUntil}, 'worker', ${leaseToken}, 1, 3, ${now}, ${now})`;
  return { now, eventId, jobId, leaseToken };
}
describe("PostgresDecisionEffectStore", () => {
  it("completes idempotently with one effect/audit and clears the lease", async () => {
    const f = await fixture();
    const store = new PostgresDecisionEffectStore(sql);
    const run = await store.startOrLoadRun({
      jobId: f.jobId,
      leaseToken: f.leaseToken,
      eventId: f.eventId,
      characterId: "primary",
      characterVersion: 1,
      routeVersion: "route-v1",
      now: f.now,
    });
    const input = {
      runId: run.runId,
      jobId: f.jobId,
      leaseToken: f.leaseToken,
      eventId: f.eventId,
      content: "返事",
      fallback: false,
      now: f.now,
    };
    await store.completeWithReply(input);
    await store.completeWithReply(input);
    await expect(sql`select state, lease_token, leased_until from jobs where id = ${f.jobId}`).resolves.toEqual([
      { state: "succeeded", lease_token: null, leased_until: null },
    ]);
    await expect(sql`select count(*)::int as count from effects where run_id = ${run.runId}`).resolves.toEqual([
      { count: 1 },
    ]);
    await expect(sql`select count(*)::int as count from audit_entries where run_id = ${run.runId}`).resolves.toEqual([
      { count: 1 },
    ]);
  });
  it("uses canonical parent capability and thread target fields", async () => {
    const f = await fixture();
    await sql`update events set channel_id = 'parent', thread_id = 'thread-1' where id = ${f.eventId}`;
    const store = new PostgresDecisionEffectStore(sql);
    const run = await store.startOrLoadRun({
      jobId: f.jobId,
      leaseToken: f.leaseToken,
      eventId: f.eventId,
      characterId: "primary",
      characterVersion: 1,
      routeVersion: "route-v1",
      now: f.now,
    });
    await store.completeWithReply({
      runId: run.runId,
      jobId: f.jobId,
      leaseToken: f.leaseToken,
      eventId: f.eventId,
      content: "返事",
      fallback: false,
      now: f.now,
    });
    await expect(
      sql`select guild_id, capability_channel_id, target_channel_id, target_message_id from effects`,
    ).resolves.toEqual([
      {
        guild_id: "g",
        capability_channel_id: "parent",
        target_channel_id: "thread-1",
        target_message_id: "message-20",
      },
    ]);
  });
  it("loads explicit mentions from observed visibility", async () => {
    const f = await fixture();
    await sql`update events set visibility = 'observed' where id = ${f.eventId}`;
    await expect(new PostgresDecisionEffectStore(sql).loadMentionEvent(f.eventId)).resolves.toMatchObject({
      eventId: f.eventId,
      text: "@bot hi",
    });
  });
  it("rejects every persisted run metadata mismatch", async () => {
    const f = await fixture();
    const store = new PostgresDecisionEffectStore(sql);
    await store.startOrLoadRun({
      jobId: f.jobId,
      leaseToken: f.leaseToken,
      eventId: f.eventId,
      characterId: "primary",
      characterVersion: 1,
      routeVersion: "route-v1",
      now: f.now,
    });
    await expect(
      store.startOrLoadRun({
        jobId: f.jobId,
        leaseToken: f.leaseToken,
        eventId: "00000000-0000-4000-8000-000000000099",
        characterId: "primary",
        characterVersion: 1,
        routeVersion: "route-v1",
        now: f.now,
      }),
    ).rejects.toThrow(/lease lost/i);
    for (const input of [{ characterId: "other" }, { characterVersion: 2 }, { routeVersion: "route-v2" }] as Array<{
      characterId?: string;
      characterVersion?: number;
      routeVersion?: string;
    }>) {
      await expect(
        store.startOrLoadRun({
          jobId: f.jobId,
          leaseToken: f.leaseToken,
          eventId: f.eventId,
          characterId: input.characterId ?? "primary",
          characterVersion: input.characterVersion ?? 1,
          routeVersion: input.routeVersion ?? "route-v1",
          now: f.now,
        }),
      ).rejects.toThrow(/metadata mismatch/i);
    }
  });
  it("rejects a stale or expired lease before creating a decision run", async () => {
    for (const [token, until] of [
      ["00000000-0000-4000-8000-000000000002", new Date("2026-07-23T00:01:00Z")],
      ["00000000-0000-4000-8000-000000000001", new Date("2026-07-22T00:00:00Z")],
    ] as const) {
      const f = await fixture("00000000-0000-4000-8000-000000000001", until);
      await expect(
        new PostgresDecisionEffectStore(sql).startOrLoadRun({
          jobId: f.jobId,
          eventId: f.eventId,
          leaseToken: token,
          characterId: "primary",
          characterVersion: 1,
          routeVersion: "route-v1",
          now: f.now,
        }),
      ).rejects.toThrow(/lease lost/i);
      await expect(sql`select count(*)::int as count from decision_runs`).resolves.toEqual([{ count: 0 }]);
      await sql`truncate audit_entries, effects, model_calls, decision_runs, jobs, events cascade`;
    }
  });
  it("rolls back completion when the lease token is stale or expired", async () => {
    for (const [token, until] of [
      ["00000000-0000-4000-8000-000000000002", new Date("2026-07-23T00:01:00Z")],
      ["00000000-0000-4000-8000-000000000001", new Date("2026-07-22T00:00:00Z")],
    ] as const) {
      const f = await fixture();
      const store = new PostgresDecisionEffectStore(sql);
      const run = await store.startOrLoadRun({
        jobId: f.jobId,
        leaseToken: f.leaseToken,
        eventId: f.eventId,
        characterId: "primary",
        characterVersion: 1,
        routeVersion: "route-v1",
        now: f.now,
      });
      await sql`update jobs set leased_until = ${until} where id = ${f.jobId}`;
      await expect(
        store.completeWithReply({
          runId: run.runId,
          jobId: f.jobId,
          leaseToken: token,
          eventId: f.eventId,
          content: "返事",
          fallback: false,
          now: f.now,
        }),
      ).rejects.toThrow(/lease lost/i);
      await expect(sql`select state, lease_token, leased_until from jobs where id = ${f.jobId}`).resolves.toEqual([
        { state: "running", lease_token: f.leaseToken, leased_until: until },
      ]);
      await expect(sql`select state from decision_runs where id = ${run.runId}`).resolves.toEqual([
        { state: "running" },
      ]);
      await expect(sql`select count(*)::int as count from effects`).resolves.toEqual([{ count: 0 }]);
      await expect(sql`select count(*)::int as count from audit_entries`).resolves.toEqual([{ count: 0 }]);
      await sql`truncate audit_entries, effects, model_calls, decision_runs, jobs, events cascade`;
    }
  });
  it("atomically fails a leased job and its running decision", async () => {
    const f = await fixture();
    const store = new PostgresDecisionEffectStore(sql);
    const run = await store.startOrLoadRun({
      jobId: f.jobId,
      leaseToken: f.leaseToken,
      eventId: f.eventId,
      characterId: "primary",
      characterVersion: 1,
      routeVersion: "route-v1",
      now: f.now,
    });
    await store.failRunAndJob(f.jobId, f.leaseToken, "x".repeat(3000), f.now);
    await expect(
      sql`select state, lease_token, leased_until, length(last_error) as error_length from jobs where id = ${f.jobId}`,
    ).resolves.toEqual([{ state: "failed", lease_token: null, leased_until: null, error_length: 25 }]);
    await expect(
      sql`select state, length(error) as error_length from decision_runs where id = ${run.runId}`,
    ).resolves.toEqual([{ state: "failed", error_length: 25 }]);
    await expect(sql`select category, run_id from audit_entries where job_id = ${f.jobId}`).resolves.toEqual([
      { category: "decision.failed", run_id: run.runId },
    ]);
  });
  it("rolls back terminal failure on a wrong token", async () => {
    const f = await fixture();
    const store = new PostgresDecisionEffectStore(sql);
    const run = await store.startOrLoadRun({
      jobId: f.jobId,
      leaseToken: f.leaseToken,
      eventId: f.eventId,
      characterId: "primary",
      characterVersion: 1,
      routeVersion: "route-v1",
      now: f.now,
    });
    await expect(store.failRunAndJob(f.jobId, "00000000-0000-4000-8000-000000000002", "bad", f.now)).rejects.toThrow(
      /lease lost/i,
    );
    await expect(sql`select state, lease_token, leased_until from jobs where id = ${f.jobId}`).resolves.toEqual([
      { state: "running", lease_token: f.leaseToken, leased_until: new Date("2026-07-23T00:01:00Z") },
    ]);
    await expect(sql`select state from decision_runs where id = ${run.runId}`).resolves.toEqual([{ state: "running" }]);
    await expect(sql`select count(*)::int as count from effects`).resolves.toEqual([{ count: 0 }]);
    await expect(sql`select count(*)::int as count from audit_entries`).resolves.toEqual([{ count: 0 }]);
  });
  it("rolls back terminal failure on an expired lease", async () => {
    const f = await fixture();
    const store = new PostgresDecisionEffectStore(sql);
    const run = await store.startOrLoadRun({
      jobId: f.jobId,
      leaseToken: f.leaseToken,
      eventId: f.eventId,
      characterId: "primary",
      characterVersion: 1,
      routeVersion: "route-v1",
      now: f.now,
    });
    await sql`update jobs set leased_until = ${new Date("2026-07-22T00:00:00Z")} where id = ${f.jobId}`;
    await expect(store.failRunAndJob(f.jobId, f.leaseToken, "expired", f.now)).rejects.toThrow(/lease lost/i);
    await expect(sql`select state, lease_token, leased_until from jobs where id = ${f.jobId}`).resolves.toEqual([
      { state: "running", lease_token: f.leaseToken, leased_until: new Date("2026-07-22T00:00:00Z") },
    ]);
    await expect(sql`select state from decision_runs where id = ${run.runId}`).resolves.toEqual([{ state: "running" }]);
    await expect(sql`select count(*)::int as count from effects`).resolves.toEqual([{ count: 0 }]);
    await expect(sql`select count(*)::int as count from audit_entries`).resolves.toEqual([{ count: 0 }]);
  });
  it("settles concurrent completion and final failure without deadlock", async () => {
    const f = await fixture();
    const completion = new PostgresDecisionEffectStore(sql);
    const failure = new PostgresDecisionEffectStore(sql);
    const run = await completion.startOrLoadRun({
      jobId: f.jobId,
      leaseToken: f.leaseToken,
      eventId: f.eventId,
      characterId: "primary",
      characterVersion: 1,
      routeVersion: "route-v1",
      now: f.now,
    });
    const complete = completion.completeWithReply({
      runId: run.runId,
      jobId: f.jobId,
      leaseToken: f.leaseToken,
      eventId: f.eventId,
      content: "返事",
      fallback: false,
      now: f.now,
    });
    const fail = failure.failRunAndJob(f.jobId, f.leaseToken, "race", f.now);
    const result = await Promise.race([
      Promise.allSettled([complete, fail]),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("deadlock")), 2000)),
    ]);
    expect(result).toHaveLength(2);
    const rows = await sql<
      Array<{ job_state: string; run_state: string; effects: number; completed: number; failed: number }>
    >`select (select state from jobs where id = ${f.jobId}) as job_state, (select state from decision_runs where id = ${run.runId}) as run_state, (select count(*)::int from effects where run_id = ${run.runId}) as effects, (select count(*)::int from audit_entries where category = 'decision.completed') as completed, (select count(*)::int from audit_entries where category = 'decision.failed') as failed`;
    expect(rows[0]!.effects + rows[0]!.failed).toBe(1);
    expect(
      rows[0]!.job_state === "succeeded"
        ? rows[0]!.run_state === "succeeded" && rows[0]!.completed === 1
        : rows[0]!.job_state === "failed" && rows[0]!.run_state === "failed" && rows[0]!.failed === 1,
    ).toBe(true);
  });
});
