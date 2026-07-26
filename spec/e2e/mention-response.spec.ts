import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { Sql } from "postgres";
import { DiscordEffectExecutor } from "../../src/adapters/discord/discord-effect-executor.js";
import { PiAgentRuntime } from "../../src/adapters/pi/pi-agent-runtime.js";
import { PostgresChannelCapabilityRepository } from "../../src/adapters/postgres/channel-capability-repository.js";
import { PostgresCharacterRepository } from "../../src/adapters/postgres/character-repository.js";
import { createPostgresClient } from "../../src/adapters/postgres/client.js";
import { PostgresDecisionEffectStore } from "../../src/adapters/postgres/decision-effect-store.js";
import { PostgresEffectQueue } from "../../src/adapters/postgres/effect-queue.js";
import { PostgresIngestionStore } from "../../src/adapters/postgres/ingestion-store.js";
import { PostgresJobQueue } from "../../src/adapters/postgres/job-queue.js";
import { runMigrations } from "../../src/adapters/postgres/migrations.js";
import { denyAllCapabilities } from "../../src/modules/channels/channel-capability.js";
import { effectNonce } from "../../src/modules/effects/effect.js";
import { ingestDiscordMessage } from "../../src/modules/events/ingest-message.js";
import { processMention } from "../../src/modules/mentions/process-mention.js";
import { FixedClock } from "../../src/shared/clock.js";

let sql: Sql;
const now = new Date("2026-07-23T00:00:00.000Z");
const clock = new FixedClock(now);
const definition = {
  schemaVersion: 1 as const,
  characterId: "primary",
  version: 1,
  name: "テストキャラクター",
  language: "ja" as const,
  systemPrompt: "あなたはDiscordコミュニティで暮らすキャラクターです。",
  failureMessages: ["今ちょっとうまく考えられない。"],
};
const input = {
  externalEventId: "discord-message-1",
  externalVersion: "0",
  guildId: "g",
  channelId: "c",
  threadId: null,
  actorId: "u",
  actorKind: "human" as const,
  occurredAt: now,
  content: "<@bot> こんにちは",
  mentionedBot: true,
  mentionIds: ["bot"],
  replyToMessageId: null,
  attachments: [],
};

beforeAll(async () => {
  sql = createPostgresClient(process.env.TEST_DATABASE_URL!);
});
beforeEach(async () => {
  await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
    actor: "test-bootstrap",
    backupConfirmedAt: new Date(),
  });
  await sql`
    update system_state
    set mode = 'running', updated_at = ${now}, updated_by = 'e2e', reason = 'reset'
    where singleton
  `;
  await sql`truncate audit_entries, effects, model_calls, decision_runs, jobs, events, character_definitions, channel_capabilities cascade`;
  await sql`
    update system_state
    set mode = 'running', updated_at = ${now}, updated_by = 'e2e', reason = 'reset'
    where singleton
  `;
});
afterAll(async () => sql.end());

async function arrange() {
  const capabilities = new PostgresChannelCapabilityRepository(sql);
  await capabilities.set(
    { ...denyAllCapabilities("g", "c"), observeEvents: true, respondToMentions: true },
    "admin",
    "e2e",
    now,
  );
  const characters = new PostgresCharacterRepository(sql);
  await characters.importDraft(definition, "admin", now);
  await characters.activate("primary", 1, "admin", now);
  return capabilities;
}

describe("explicit mention durable spine", () => {
  it("persists, decides, and executes exactly one reply", async () => {
    const capabilities = await arrange();
    const ingestion = new PostgresIngestionStore(sql);
    const capability = await capabilities.get("g", "c");
    const first = await ingestDiscordMessage(input, capability, "running", ingestion, clock);
    const duplicate = await ingestDiscordMessage(input, capability, "running", ingestion, clock);
    expect(first).toMatchObject({ kind: "accepted", duplicate: false, jobQueued: true });
    expect(duplicate).toMatchObject({ kind: "accepted", duplicate: true, jobQueued: false });

    const queue = new PostgresJobQueue(sql);
    const job = await queue.claim("worker", now, 60_000);
    expect(job).not.toBeNull();
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("どうしたの？")]);
    await processMention(
      job!,
      definition,
      {
        version: "route-v1",
        mentionResponseDeadlineMs: 25_000,
        mentionResponse: [
          { provider: faux.provider.id, model: faux.getModel().id, thinkingLevel: "off", timeoutMs: 5_000 },
        ],
      },
      new PiAgentRuntime(models),
      new PostgresDecisionEffectStore(sql),
      clock,
    );

    await expect(sql`select state from jobs where id = ${job!.id}`).resolves.toEqual([{ state: "succeeded" }]);
    const counts = await sql<
      Array<{ events: number; jobs: number; runs: number; calls: number; effects: number; audits: number }>
    >`
      select
        (select count(*)::int from events) as events,
        (select count(*)::int from jobs) as jobs,
        (select count(*)::int from decision_runs where state = 'succeeded') as runs,
        (select count(*)::int from model_calls) as calls,
        (select count(*)::int from effects where state = 'planned') as effects,
        (select count(*)::int from audit_entries where category = 'decision.completed') as audits
    `;
    expect(counts[0]).toEqual({ events: 1, jobs: 1, runs: 1, calls: 1, effects: 1, audits: 1 });

    const effectQueue = new PostgresEffectQueue(sql);
    const effect = await effectQueue.claim("gateway", now);
    expect(effect).not.toBeNull();
    const reply = vi.fn().mockResolvedValue({ id: "discord-message-2" });
    await new DiscordEffectExecutor({ reply }, effectQueue).execute(effect!, clock);
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: "g", nonce: effectNonce(effect!.id), enforceNonce: true }),
    );
    expect(await effectQueue.get(effect!.id)).toEqual({ state: "succeeded", externalResourceId: "discord-message-2" });
    expect(await queue.claim("worker", now, 60_000)).toBeNull();
    expect(await effectQueue.claim("gateway", now)).toBeNull();
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it("uses a character fallback without exposing provider errors", async () => {
    const capabilities = await arrange();
    const ingestion = new PostgresIngestionStore(sql);
    await ingestDiscordMessage(input, await capabilities.get("g", "c"), "running", ingestion, clock);
    const queue = new PostgresJobQueue(sql);
    const job = await queue.claim("worker", now, 30_000);
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider secret failure" })]);
    await processMention(
      job!,
      definition,
      {
        version: "route-v1",
        mentionResponseDeadlineMs: 25_000,
        mentionResponse: [
          { provider: faux.provider.id, model: faux.getModel().id, thinkingLevel: "off", timeoutMs: 5_000 },
        ],
      },
      new PiAgentRuntime(models),
      new PostgresDecisionEffectStore(sql),
      clock,
    );
    await expect(sql`select state from jobs where id = ${job!.id}`).resolves.toEqual([{ state: "succeeded" }]);
    await expect(queue.claim("worker", now, 60_000)).resolves.toBeNull();
    const effectQueue = new PostgresEffectQueue(sql);
    const effect = await effectQueue.claim("gateway", now);
    expect(effect).not.toBeNull();
    expect(effect!.content).toBe(definition.failureMessages[0]);
    expect(effect!.content).not.toContain("provider");
    const reply = vi.fn().mockResolvedValue({ id: "discord-message-fallback" });
    await new DiscordEffectExecutor({ reply }, effectQueue).execute(effect!, clock);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(await effectQueue.get(effect!.id)).toMatchObject({
      state: "succeeded",
      externalResourceId: "discord-message-fallback",
    });
    expect(await effectQueue.claim("gateway", now)).toBeNull();
    const states = await sql<Array<{ job: string; run: string }>>`
      select jobs.state job, decision_runs.state run
      from jobs join decision_runs on decision_runs.job_id = jobs.id
      where jobs.id = ${job!.id}
    `;
    expect(states).toEqual([{ job: "succeeded", run: "succeeded" }]);
    const loggable = await sql<Array<Record<string, unknown>>>`
      select last_error, null::text as decision_error, null::text[] as reason_codes, null::text as model_error, null::text as audit_summary, null::text as effect_error
      from jobs where id = ${job!.id}
      union all
      select null, error, reason_codes, null, null, null from decision_runs where job_id = ${job!.id}
      union all
      select null, null, null, model_calls.error, null, null from model_calls join decision_runs on decision_runs.id = model_calls.run_id where decision_runs.job_id = ${job!.id}
      union all
      select null, null, null, null, summary::text, null from audit_entries where job_id = ${job!.id}
      union all
      select null, null, null, null, null, effects.error from effects join decision_runs on decision_runs.id = effects.run_id where decision_runs.job_id = ${job!.id}
    `;
    expect(JSON.stringify(loggable)).not.toContain("provider secret failure");
  });
});
