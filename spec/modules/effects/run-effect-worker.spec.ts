import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { Sql } from "postgres";
import { PiAgentRuntime } from "../../../src/adapters/pi/pi-agent-runtime.js";
import { PostgresChannelCapabilityRepository } from "../../../src/adapters/postgres/channel-capability-repository.js";
import { PostgresCharacterRepository } from "../../../src/adapters/postgres/character-repository.js";
import { createPostgresClient } from "../../../src/adapters/postgres/client.js";
import { PostgresDecisionEffectStore } from "../../../src/adapters/postgres/decision-effect-store.js";
import { PostgresEffectiveCapabilityRepository } from "../../../src/adapters/postgres/effective-capability-repository.js";
import { PostgresEffectQueue } from "../../../src/adapters/postgres/effect-queue.js";
import { PostgresIngestionStore } from "../../../src/adapters/postgres/ingestion-store.js";
import { PostgresJobQueue } from "../../../src/adapters/postgres/job-queue.js";
import { runMigrations } from "../../../src/adapters/postgres/migrations.js";
import { PostgresThreadCapabilityRepository } from "../../../src/adapters/postgres/thread-capability-repository.js";
import { runOneEffect } from "../../../src/modules/effects/run-effect-worker.js";
import { ingestDiscordMessage } from "../../../src/modules/events/ingest-message.js";
import { processConversation } from "../../../src/modules/conversations/evaluate-conversation.js";
import { FixedClock } from "../../../src/shared/clock.js";

let sql: Sql;
const now = new Date("2026-07-24T00:00:00.000Z");
const clock = new FixedClock(now);
const batchConfig = { batchWindowMs: 8_000, maxWaitMs: 30_000 };
const claimAt = new Date(now.getTime() + 8_000);
const guildId = "run-effect-worker-guild";
const channelId = "run-effect-worker-channel";
const threadId = "run-effect-worker-thread";
const definition = {
  schemaVersion: 1 as const,
  characterId: "primary",
  version: 1,
  name: "テストキャラクター",
  language: "ja" as const,
  systemPrompt: "あなたはDiscordコミュニティで暮らすキャラクターです。",
  failureMessages: ["今ちょっとうまく考えられない。"],
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
    update system_state set mode = 'running', updated_at = ${now}, updated_by = 'spec', reason = 'reset' where singleton
  `;
  await sql`
    truncate audit_entries, effects, model_calls, run_input_events, decision_runs, jobs, conversation_cursors,
      actor_states, events, character_definitions, channel_capabilities, thread_capability_overrides cascade
  `;
});
afterAll(async () => sql.end());

// Establishes whatever capability state `setup` describes, ingests a mention in `threadId` under that
// state, and runs it through the real decision pipeline so it leaves behind a planned `effects` row
// with capability_channel_id = channelId and target_channel_id = threadId - mirroring how
// src/adapters/postgres/decision-effect-store.ts derives target_channel_id from the thread the message
// was posted in. Capability state can then be changed again by the caller to simulate a revocation
// that happens after the decision but before the effect is executed.
async function queuePlannedThreadEffect(
  setup: (channels: PostgresChannelCapabilityRepository, threads: PostgresThreadCapabilityRepository) => Promise<void>,
): Promise<{
  channels: PostgresChannelCapabilityRepository;
  threads: PostgresThreadCapabilityRepository;
  effectiveCapabilities: PostgresEffectiveCapabilityRepository;
  effectQueue: PostgresEffectQueue;
}> {
  const channels = new PostgresChannelCapabilityRepository(sql);
  const threads = new PostgresThreadCapabilityRepository(sql);
  const effectiveCapabilities = new PostgresEffectiveCapabilityRepository(channels, threads);
  await setup(channels, threads);
  const characters = new PostgresCharacterRepository(sql);
  await characters.importDraft(definition, "admin", now);
  await characters.activate("primary", 1, "admin", now);

  const capability = await effectiveCapabilities.get(guildId, channelId, threadId);
  const ingestion = new PostgresIngestionStore(sql);
  const input = {
    externalEventId: "run-effect-worker-message",
    externalVersion: "0",
    guildId,
    channelId,
    threadId,
    actorId: "user-1",
    actorKind: "human" as const,
    occurredAt: now,
    content: "<@bot> こんにちは",
    mentionedBot: true,
    mentionIds: ["bot"],
    replyToMessageId: null,
    attachments: [] as Array<{ id: string; name: string; contentType: string | null; url: string; size: number }>,
  };
  const result = await ingestDiscordMessage(input, capability, "running", batchConfig, ingestion, clock);
  if (result.kind !== "accepted" || !result.jobQueued) throw new Error("test setup failed to queue a mention job");

  const jobQueue = new PostgresJobQueue(sql);
  const job = await jobQueue.claim("worker", claimAt, 60_000);
  if (!job) throw new Error("test setup failed to claim the mention job");
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("スレッドでのお返事です")]);
  await processConversation(
    job,
    claimAt,
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
    new FixedClock(claimAt),
  );

  return { channels, threads, effectiveCapabilities, effectQueue: new PostgresEffectQueue(sql) };
}

describe("runOneEffect + PostgresEffectiveCapabilityRepository", () => {
  it("fails an effect once a thread override revokes mention responses after the decision was made", async () => {
    const { threads, effectiveCapabilities, effectQueue } = await queuePlannedThreadEffect(async (channels) => {
      await channels.patch(guildId, channelId, { respondToMentions: true }, "admin", "allow channel", now);
    });
    // Simulate the parent channel allowing the reply at decision time, then a moderator narrowing the
    // thread after the effect was already queued but before it was executed.
    await threads.patch(guildId, channelId, threadId, { respondToMentions: false }, "moderator", "quiet thread", now);

    const executor = { execute: vi.fn().mockResolvedValue(undefined) };
    await expect(runOneEffect(effectQueue, effectiveCapabilities, executor, "worker", clock)).resolves.toBe(true);

    expect(executor.execute).not.toHaveBeenCalled();
    const rows = await sql<Array<{ state: string; error: string | null }>>`
      select state, error from effects where guild_id = ${guildId} and target_channel_id = ${threadId}
    `;
    expect(rows).toEqual([{ state: "failed", error: "capability_revoked" }]);
  });

  it("executes an effect that a thread override allows despite the parent channel denying it", async () => {
    // Parent channel stays deny-all (channels.patch is never called); only the thread override allows it,
    // and it must already be in place before ingest so the mention is accepted in the first place.
    const { effectiveCapabilities, effectQueue } = await queuePlannedThreadEffect(async (_channels, threads) => {
      await threads.patch(guildId, channelId, threadId, { respondToMentions: true }, "moderator", "allow thread", now);
    });

    const executor = { execute: vi.fn().mockResolvedValue(undefined) };
    await expect(runOneEffect(effectQueue, effectiveCapabilities, executor, "worker", clock)).resolves.toBe(true);

    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId,
        capabilityChannelId: channelId,
        targetChannelId: threadId,
        threadId,
        content: "スレッドでのお返事です",
      }),
      clock,
    );
  });
});
