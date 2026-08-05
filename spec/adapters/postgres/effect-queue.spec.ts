import { describe, expect, it } from "vitest";
import { createPostgresClient } from "../../../src/adapters/postgres/client.js";
import { PostgresEffectQueue } from "../../../src/adapters/postgres/effect-queue.js";
import { runMigrations } from "../../../src/adapters/postgres/migrations.js";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("PostgresEffectQueue", () => {
  it("claims one planned effect concurrently and persists its transitions", async () => {
    const sql = createPostgresClient(url!);
    await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
      actor: "test-bootstrap",
      backupConfirmedAt: new Date(),
    });
    await sql`truncate audit_entries, effects, run_input_events, decision_runs, jobs, conversation_cursors, actor_states, events cascade`;
    const now = new Date("2026-01-01T00:00:00Z");
    const eventId = "00000000-0000-0000-0000-000000000001";
    const runId = "00000000-0000-0000-0000-000000000002";
    const effectId = "00000000-0000-0000-0000-000000000003";
    await sql`insert into events (id,schema_version,source,external_event_id,external_version,kind,visibility,guild_id,channel_id,actor_id,actor_kind,occurred_at,received_at,content,expires_at) values (${eventId},1,'discord','m','1','message.created','observed','g','c','a','human',${now},${now},${sql.json({})},${now})`;
    await sql`insert into jobs (id,kind,guild_id,channel_id,thread_id,trigger_event_id,state,available_at,first_triggered_at,created_at,updated_at) values ('00000000-0000-0000-0000-000000000004','conversation_evaluate','g','c',null,${eventId},'queued',${now},${now},${now},${now})`;
    await sql`insert into decision_runs (id,job_id,event_id,character_id,character_version,model_route_version,state,started_at) values (${runId},'00000000-0000-0000-0000-000000000004',${eventId},'c',1,'r','succeeded',${now})`;
    await sql`insert into effects (id,run_id,effect_slot,kind,state,guild_id,capability_channel_id,target_channel_id,target_message_id,payload,capability_decision,created_at,updated_at) values (${effectId},${runId},'primary_reply','discord.reply','planned','g','cap','target','message',${sql.json({ content: "hello", allowedMentions: { parse: [], repliedUser: false } })},${sql.json({})},${now},${now})`;
    const [a, b] = await Promise.all([
      new PostgresEffectQueue(sql).claim("a", now),
      new PostgresEffectQueue(sql).claim("b", now),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const plannedInspection = await new PostgresEffectQueue(sql).inspect(effectId);
    expect(plannedInspection).toMatchObject({
      id: effectId,
      runId,
      effectSlot: "primary_reply",
      kind: "discord.reply",
      state: "executing",
      guildId: "g",
      capabilityChannelId: "cap",
      targetChannelId: "target",
      threadId: null,
      targetMessageId: "message",
      content: "hello",
      allowedMentions: { parse: [], repliedUser: false },
      externalResourceId: null,
      executorId: expect.stringMatching(/^[ab]$/),
      attempts: 1,
      error: null,
    });
    expect(plannedInspection.createdAt).toEqual(now);
    expect(plannedInspection.updatedAt).toEqual(now);
    await new PostgresEffectQueue(sql).succeed(effectId, "external", now);
    expect(await sql`select state, external_resource_id, attempts from effects where id=${effectId}`).toEqual([
      { state: "succeeded", external_resource_id: "external", attempts: 1 },
    ]);
    expect(await sql`select category from audit_entries where effect_id=${effectId}`).toEqual([
      { category: "effect.succeeded" },
    ]);
    await sql`update effects set payload=${sql.json({ content: "", allowedMentions: { parse: [], repliedUser: false } })} where id=${effectId}`;
    await expect(new PostgresEffectQueue(sql).inspect(effectId)).rejects.toThrow();
    const poisonId = "00000000-0000-0000-0000-000000000005";
    const validId = "00000000-0000-0000-0000-000000000006";
    await sql`insert into effects (id,run_id,effect_slot,kind,state,guild_id,capability_channel_id,target_channel_id,target_message_id,payload,capability_decision,created_at,updated_at) values (${poisonId},${runId},'poison','discord.reply','planned','g','cap','target','poison',${sql.json({ content: "" })},${sql.json({})},${new Date(now.getTime() + 1)},${now})`;
    await sql`insert into effects (id,run_id,effect_slot,kind,state,guild_id,capability_channel_id,target_channel_id,target_message_id,payload,capability_decision,created_at,updated_at) values (${validId},${runId},'valid','discord.reply','planned','g','cap','target','valid',${sql.json({ content: "next", allowedMentions: { parse: [], repliedUser: false } })},${sql.json({})},${new Date(now.getTime() + 2)},${now})`;
    await expect(new PostgresEffectQueue(sql).claim("poison", now)).resolves.toBeNull();
    expect(await sql`select state,error from effects where id=${poisonId}`).toEqual([
      { state: "failed", error: "invalid_effect_payload" },
    ]);
    expect(
      await sql`select category,summary->>'error' as error from audit_entries where effect_id=${poisonId}`,
    ).toEqual([{ category: "effect.failed", error: "invalid_effect_payload" }]);
    await expect(new PostgresEffectQueue(sql).claim("valid", now)).resolves.toMatchObject({
      id: validId,
      content: "next",
    });
    await sql.end({ timeout: 1 });
  });

  it("enforces mode gates, recovery, reconciliation, and invalid transitions", async () => {
    const sql = createPostgresClient(url!);
    await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
      actor: "test-bootstrap",
      backupConfirmedAt: new Date(),
    });
    await sql`truncate audit_entries, effects, run_input_events, decision_runs, jobs, conversation_cursors, actor_states, events cascade`;
    const now = new Date("2026-01-01T00:00:00Z");
    const eventId = "00000000-0000-0000-0000-000000000011";
    const jobId = "00000000-0000-0000-0000-000000000012";
    const runId = "00000000-0000-0000-0000-000000000013";
    const effectId = "00000000-0000-0000-0000-000000000014";
    await sql`insert into events (id,schema_version,source,external_event_id,external_version,kind,visibility,guild_id,channel_id,actor_id,actor_kind,occurred_at,received_at,content,expires_at) values (${eventId},1,'discord','m2','1','message.created','observed','g2','c2','a2','human',${now},${now},${sql.json({})},${now})`;
    await sql`insert into jobs (id,kind,guild_id,channel_id,thread_id,trigger_event_id,state,available_at,first_triggered_at,created_at,updated_at) values (${jobId},'conversation_evaluate','g2','c2',null,${eventId},'queued',${now},${now},${now},${now})`;
    await sql`insert into decision_runs (id,job_id,event_id,character_id,character_version,model_route_version,state,started_at) values (${runId},${jobId},${eventId},'c',1,'r','succeeded',${now})`;
    const payload = sql.json({ content: "hello", allowedMentions: { parse: [], repliedUser: false } });
    await sql`insert into effects (id,run_id,effect_slot,kind,state,guild_id,capability_channel_id,target_channel_id,thread_id,target_message_id,payload,capability_decision,created_at,updated_at) values (${effectId},${runId},'primary_reply','discord.reply','planned','g2','cap2','target2','target2','message2',${payload},${sql.json({})},${now},${now})`;
    await sql`update system_state set mode='stopped' where singleton`;
    await expect(new PostgresEffectQueue(sql).claim("stopped", now)).resolves.toBeNull();
    await sql`update system_state set mode='draining' where singleton`;
    const claimed = await new PostgresEffectQueue(sql).claim("draining", now);
    expect(claimed).toMatchObject({
      id: effectId,
      targetChannelId: "target2",
      threadId: "target2",
      targetMessageId: "message2",
      content: "hello",
      attempts: 1,
    });
    expect(await sql`select executor_id, attempts from effects where id=${effectId}`).toEqual([
      { executor_id: "draining", attempts: 1 },
    ]);
    await expect(new PostgresEffectQueue(sql).succeed(effectId, "discord-2", now)).resolves.toBeUndefined();
    await expect(new PostgresEffectQueue(sql).succeed(effectId, "discord-2", now)).rejects.toThrow(
      "Invalid effect transition",
    );
    expect(
      await sql`select category, summary->>'externalResourceId' as external_id from audit_entries where effect_id=${effectId}`,
    ).toEqual([{ category: "effect.succeeded", external_id: "discord-2" }]);

    await sql`update effects set state='executing' where id=${effectId}`;
    await new PostgresEffectQueue(sql).fail(effectId, "rest failed", now);
    expect(await sql`select state, error from effects where id=${effectId}`).toEqual([
      { state: "failed", error: "effect_execution_failed" },
    ]);
    expect(
      await sql`select category from audit_entries where effect_id=${effectId} order by created_at, id`,
    ).toHaveLength(2);

    await sql`update effects set state='executing' where id=${effectId}`;
    await new PostgresEffectQueue(sql).markUnknown(effectId, "network timeout", now);
    expect(await new PostgresEffectQueue(sql).get(effectId)).toEqual({ state: "unknown", externalResourceId: null });
    await expect(
      new PostgresEffectQueue(sql).reconcileUnknown(effectId, "succeeded", null, "", "reason", now),
    ).rejects.toThrow("Actor is required");
    await new PostgresEffectQueue(sql).reconcileUnknown(
      effectId,
      "succeeded",
      "discord-3",
      "operator",
      "checked Discord",
      now,
    );
    expect(await new PostgresEffectQueue(sql).get(effectId)).toEqual({
      state: "succeeded",
      externalResourceId: "discord-3",
    });

    await sql`update effects set state='executing' where id=${effectId}`;
    expect(await new PostgresEffectQueue(sql).recoverExecutingAsUnknown(now)).toBe(1);
    expect(await new PostgresEffectQueue(sql).get(effectId)).toEqual({
      state: "unknown",
      externalResourceId: "discord-3",
    });
    expect(
      await sql`select count(*)::int as count from audit_entries where category='effect.unknown' and effect_id=${effectId}`,
    ).toEqual([{ count: 2 }]);
    await sql.end({ timeout: 1 });
  });
});
