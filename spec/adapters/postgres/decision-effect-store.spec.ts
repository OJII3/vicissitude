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
  await sql`truncate audit_entries, effects, model_calls, run_input_events, decision_runs, jobs, conversation_cursors, actor_states, events cascade`;
});
async function fixture(
  leaseToken = "00000000-0000-4000-8000-000000000001",
  leasedUntil = new Date("2026-07-23T00:01:00Z"),
) {
  const now = new Date("2026-07-23T00:00:00Z");
  const eventId = "00000000-0000-4000-8000-000000000020";
  const jobId = "00000000-0000-4000-8000-000000000021";
  await sql`insert into events (id, schema_version, source, external_event_id, external_version, kind, visibility, guild_id, channel_id, actor_id, actor_kind, occurred_at, received_at, content, expires_at) values (${eventId}, 1, 'discord', 'message-20', '0', 'message.created', 'mention_only', 'g', 'c', 'u', 'human', ${now}, ${now}, ${sql.json({ text: "@bot hi", mentionedBot: true, mentionIds: ["bot"], replyToMessageId: null, attachments: [] })}, ${new Date("2026-08-22T00:00:00Z")})`;
  await sql`insert into jobs (id, kind, guild_id, channel_id, thread_id, trigger_event_id, state, available_at, first_triggered_at, leased_until, lease_owner, lease_token, attempts, max_attempts, created_at, updated_at) values (${jobId}, 'conversation_evaluate', 'g', 'c', null, ${eventId}, 'running', ${now}, ${now}, ${leasedUntil}, 'worker', ${leaseToken}, 1, 3, ${now}, ${now})`;
  return { now, eventId, jobId, leaseToken };
}
describe("PostgresDecisionEffectStore", () => {
  it("completes idempotently with one effect/audit and clears the lease", async () => {
    const f = await fixture();
    const store = new PostgresDecisionEffectStore(sql);
    const run = await store.startOrLoadRun({
      jobId: f.jobId,
      leaseToken: f.leaseToken,
      triggerEventId: f.eventId,
      characterId: "primary",
      characterVersion: 1,
      routeVersion: "route-v1",
      now: f.now,
    });
    const input = {
      runId: run.runId,
      jobId: f.jobId,
      leaseToken: f.leaseToken,
      triggerEventId: f.eventId,
      cursor: { lastEventId: f.eventId, lastOccurredAt: f.now },
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
    await expect(sql`select thread_id from effects where run_id = ${run.runId}`).resolves.toEqual([
      { thread_id: null },
    ]);
    await expect(sql`select count(*)::int as count from audit_entries where run_id = ${run.runId}`).resolves.toEqual([
      { count: 1 },
    ]);
  });
  it("uses canonical parent capability and thread target fields", async () => {
    const f = await fixture();
    await sql`update events set channel_id = 'parent', thread_id = 'thread-1' where id = ${f.eventId}`;
    await sql`update jobs set channel_id = 'parent', thread_id = 'thread-1' where id = ${f.jobId}`;
    const store = new PostgresDecisionEffectStore(sql);
    const run = await store.startOrLoadRun({
      jobId: f.jobId,
      leaseToken: f.leaseToken,
      triggerEventId: f.eventId,
      characterId: "primary",
      characterVersion: 1,
      routeVersion: "route-v1",
      now: f.now,
    });
    await store.completeWithReply({
      runId: run.runId,
      jobId: f.jobId,
      leaseToken: f.leaseToken,
      triggerEventId: f.eventId,
      cursor: { lastEventId: f.eventId, lastOccurredAt: f.now },
      content: "返事",
      fallback: false,
      now: f.now,
    });
    await expect(
      sql`select guild_id, capability_channel_id, target_channel_id, thread_id, target_message_id from effects`,
    ).resolves.toEqual([
      {
        guild_id: "g",
        capability_channel_id: "parent",
        target_channel_id: "thread-1",
        thread_id: "thread-1",
        target_message_id: "message-20",
      },
    ]);
  });
  it("loads explicit mentions from observed visibility", async () => {
    const f = await fixture();
    await sql`update events set visibility = 'observed' where id = ${f.eventId}`;
    const batch = await new PostgresDecisionEffectStore(sql).loadBatch(
      { guildId: "g", channelId: "c", threadId: null, triggerEventId: f.eventId },
      new Date("2026-07-23T00:00:10Z"),
    );
    expect(batch.trigger).toMatchObject({ eventId: f.eventId, text: "@bot hi", mentionedBot: true });
    expect(batch).toMatchObject({ guildId: "g", capabilityChannelId: "c", targetChannelId: "c", threadId: null });
  });

  it("rejects a trigger event that is not a mention", async () => {
    const f = await fixture();
    await sql`update events set content = ${sql.json({ text: "hi", mentionedBot: false, mentionIds: [], replyToMessageId: null, attachments: [] })} where id = ${f.eventId}`;
    await expect(
      new PostgresDecisionEffectStore(sql).loadBatch(
        { guildId: "g", channelId: "c", threadId: null, triggerEventId: f.eventId },
        new Date("2026-07-23T00:00:10Z"),
      ),
    ).rejects.toThrow(/not a mention/u);
  });
  it("rejects every persisted run metadata mismatch", async () => {
    const f = await fixture();
    const store = new PostgresDecisionEffectStore(sql);
    await store.startOrLoadRun({
      jobId: f.jobId,
      leaseToken: f.leaseToken,
      triggerEventId: f.eventId,
      characterId: "primary",
      characterVersion: 1,
      routeVersion: "route-v1",
      now: f.now,
    });
    await expect(
      store.startOrLoadRun({
        jobId: f.jobId,
        leaseToken: f.leaseToken,
        triggerEventId: "00000000-0000-4000-8000-000000000099",
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
          triggerEventId: f.eventId,
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
          triggerEventId: f.eventId,
          leaseToken: token,
          characterId: "primary",
          characterVersion: 1,
          routeVersion: "route-v1",
          now: f.now,
        }),
      ).rejects.toThrow(/lease lost/i);
      await expect(sql`select count(*)::int as count from decision_runs`).resolves.toEqual([{ count: 0 }]);
      await sql`truncate audit_entries, effects, model_calls, run_input_events, decision_runs, jobs, conversation_cursors, actor_states, events cascade`;
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
        triggerEventId: f.eventId,
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
          triggerEventId: f.eventId,
          cursor: { lastEventId: f.eventId, lastOccurredAt: f.now },
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
      await sql`truncate audit_entries, effects, model_calls, run_input_events, decision_runs, jobs, conversation_cursors, actor_states, events cascade`;
    }
  });
  it("atomically fails a leased job and its running decision", async () => {
    const f = await fixture();
    const store = new PostgresDecisionEffectStore(sql);
    const run = await store.startOrLoadRun({
      jobId: f.jobId,
      leaseToken: f.leaseToken,
      triggerEventId: f.eventId,
      characterId: "primary",
      characterVersion: 1,
      routeVersion: "route-v1",
      now: f.now,
    });
    await store.failRunAndJob(f.jobId, f.leaseToken, "x".repeat(3000), f.now);
    await expect(
      sql`select state, lease_token, leased_until, length(last_error) as error_length from jobs where id = ${f.jobId}`,
    ).resolves.toEqual([{ state: "failed", lease_token: null, leased_until: null, error_length: 30 }]);
    await expect(
      sql`select state, length(error) as error_length from decision_runs where id = ${run.runId}`,
    ).resolves.toEqual([{ state: "failed", error_length: 30 }]);
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
      triggerEventId: f.eventId,
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
      triggerEventId: f.eventId,
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
      triggerEventId: f.eventId,
      characterId: "primary",
      characterVersion: 1,
      routeVersion: "route-v1",
      now: f.now,
    });
    const complete = completion.completeWithReply({
      runId: run.runId,
      jobId: f.jobId,
      leaseToken: f.leaseToken,
      triggerEventId: f.eventId,
      cursor: { lastEventId: f.eventId, lastOccurredAt: f.now },
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

  it("reads the batch after the cursor and up to the claim time", async () => {
    const f = await fixture();
    const store = new PostgresDecisionEffectStore(sql);
    const insertEvent = async (id: string, occurredAt: Date, text: string, mentioned = false) =>
      sql`insert into events (id, schema_version, source, external_event_id, external_version, kind, visibility, guild_id, channel_id, actor_id, actor_kind, occurred_at, received_at, content, expires_at) values (${id}, 1, 'discord', ${id}, '0', 'message.created', 'observed', 'g', 'c', 'u', 'human', ${occurredAt}, ${occurredAt}, ${sql.json({ text, mentionedBot: mentioned, mentionIds: [], replyToMessageId: null, attachments: [] })}, ${new Date("2026-08-22T00:00:00Z")})`;
    const before = "00000000-0000-4000-8000-000000000030";
    const after = "00000000-0000-4000-8000-000000000031";
    const late = "00000000-0000-4000-8000-000000000032";
    await insertEvent(before, new Date("2026-07-22T23:59:00Z"), "cursor 以前");
    await insertEvent(after, new Date("2026-07-23T00:00:03Z"), "batch 内");
    await insertEvent(late, new Date("2026-07-23T00:00:20Z"), "claim 後");
    await sql`insert into conversation_cursors (guild_id, channel_id, thread_id, last_event_id, last_occurred_at, updated_at) values ('g', 'c', '', ${before}, ${new Date("2026-07-22T23:59:00Z")}, ${f.now})`;

    const batch = await store.loadBatch(
      { guildId: "g", channelId: "c", threadId: null, triggerEventId: f.eventId },
      new Date("2026-07-23T00:00:10Z"),
    );
    expect(batch.messages.map((message) => message.eventId)).toEqual([f.eventId, after]);
    expect(batch.trigger.eventId).toBe(f.eventId);
  });

  it("always includes the trigger even when it occurred after the claim time", async () => {
    const f = await fixture();
    const store = new PostgresDecisionEffectStore(sql);
    const batch = await store.loadBatch(
      { guildId: "g", channelId: "c", threadId: null, triggerEventId: f.eventId },
      new Date(f.now.getTime() - 60_000),
    );
    expect(batch.messages.map((message) => message.eventId)).toEqual([f.eventId]);
    expect(batch.trigger.eventId).toBe(f.eventId);
  });

  it("always includes the trigger even when the cursor has passed it", async () => {
    const f = await fixture();
    const store = new PostgresDecisionEffectStore(sql);
    await sql`insert into conversation_cursors (guild_id, channel_id, thread_id, last_event_id, last_occurred_at, updated_at) values ('g', 'c', '', '00000000-0000-4000-8000-000000000040', ${new Date("2026-07-23T01:00:00Z")}, ${f.now})`;
    const batch = await store.loadBatch(
      { guildId: "g", channelId: "c", threadId: null, triggerEventId: f.eventId },
      new Date("2026-07-23T00:00:10Z"),
    );
    expect(batch.messages.map((message) => message.eventId)).toEqual([f.eventId]);
    expect(batch.trigger.eventId).toBe(f.eventId);
  });

  it("records run input events idempotently", async () => {
    const f = await fixture();
    const store = new PostgresDecisionEffectStore(sql);
    const run = await store.startOrLoadRun({
      jobId: f.jobId,
      triggerEventId: f.eventId,
      leaseToken: f.leaseToken,
      characterId: "primary",
      characterVersion: 1,
      routeVersion: "route-v1",
      now: f.now,
    });
    await store.recordRunInputEvents(run.runId, [f.eventId]);
    await store.recordRunInputEvents(run.runId, [f.eventId]);
    await expect(sql`select count(*)::int as count from run_input_events where run_id = ${run.runId}`).resolves.toEqual(
      [{ count: 1 }],
    );
  });

  it("advances the cursor on completion", async () => {
    const f = await fixture();
    const store = new PostgresDecisionEffectStore(sql);
    const run = await store.startOrLoadRun({
      jobId: f.jobId,
      triggerEventId: f.eventId,
      leaseToken: f.leaseToken,
      characterId: "primary",
      characterVersion: 1,
      routeVersion: "route-v1",
      now: f.now,
    });
    await store.completeWithReply({
      runId: run.runId,
      jobId: f.jobId,
      leaseToken: f.leaseToken,
      triggerEventId: f.eventId,
      cursor: { lastEventId: f.eventId, lastOccurredAt: f.now },
      content: "返事",
      fallback: false,
      now: f.now,
    });
    await expect(
      sql`select last_event_id, last_occurred_at from conversation_cursors where guild_id = 'g' and channel_id = 'c' and thread_id = ''`,
    ).resolves.toEqual([{ last_event_id: f.eventId, last_occurred_at: f.now }]);
  });

  it("never moves the cursor backwards on completion", async () => {
    const f = await fixture();
    const store = new PostgresDecisionEffectStore(sql);
    const ahead = "00000000-0000-4000-8000-000000000041";
    const aheadAt = new Date("2026-07-23T01:00:00Z");
    await sql`insert into conversation_cursors (guild_id, channel_id, thread_id, last_event_id, last_occurred_at, updated_at) values ('g', 'c', '', ${ahead}, ${aheadAt}, ${f.now})`;
    const run = await store.startOrLoadRun({
      jobId: f.jobId,
      triggerEventId: f.eventId,
      leaseToken: f.leaseToken,
      characterId: "primary",
      characterVersion: 1,
      routeVersion: "route-v1",
      now: f.now,
    });
    await store.completeWithReply({
      runId: run.runId,
      jobId: f.jobId,
      leaseToken: f.leaseToken,
      triggerEventId: f.eventId,
      cursor: { lastEventId: f.eventId, lastOccurredAt: f.now },
      content: "返事",
      fallback: false,
      now: f.now,
    });
    await expect(
      sql`select last_event_id, last_occurred_at from conversation_cursors where guild_id = 'g' and channel_id = 'c' and thread_id = ''`,
    ).resolves.toEqual([{ last_event_id: ahead, last_occurred_at: aheadAt }]);
    await expect(sql`select state from jobs where id = ${f.jobId}`).resolves.toEqual([{ state: "succeeded" }]);
  });
});
