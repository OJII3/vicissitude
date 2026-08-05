import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createPostgresClient } from "../../../src/adapters/postgres/client.js";
import { runMigrations } from "../../../src/adapters/postgres/migrations.js";
import { denyAllCapabilities, type ChannelCapabilities } from "../../../src/modules/channels/channel-capability.js";
import type { CanonicalMessageEvent } from "../../../src/modules/events/canonical-event.js";
import type { ConversationJobDirective } from "../../../src/modules/events/ingest-message.js";
import {
  PostgresChannelCapabilityRepository,
  type ChannelCapabilitiesPatch,
} from "../../../src/adapters/postgres/channel-capability-repository.js";
import { PostgresIngestionStore } from "../../../src/adapters/postgres/ingestion-store.js";

let sql: Sql;

beforeAll(async () => {
  sql = createPostgresClient(process.env.TEST_DATABASE_URL!);
  await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
    actor: "test-bootstrap",
    backupConfirmedAt: new Date(),
  });
});

beforeEach(async () => {
  await sql`truncate audit_entries, effects, model_calls, run_input_events, decision_runs, jobs, conversation_cursors, actor_states, events, channel_capabilities cascade`;
});

afterAll(async () => {
  await sql.end();
});

describe("PostgresChannelCapabilityRepository", () => {
  it("returns deny-all capabilities without writing a missing row", async () => {
    const repository = new PostgresChannelCapabilityRepository(sql);

    await expect(repository.get("guild-1", "channel-1")).resolves.toEqual(denyAllCapabilities("guild-1", "channel-1"));
    await expect(sql`select * from channel_capabilities`).resolves.toHaveLength(0);
  });

  it("round-trips capabilities and records the change audit", async () => {
    const repository = new PostgresChannelCapabilityRepository(sql);
    const value: ChannelCapabilities = {
      guildId: "guild-1",
      channelId: "channel-1",
      observeEvents: true,
      respondToMentions: true,
      spontaneousJoin: false,
      spontaneousTopic: true,
      addReactions: false,
      createThreads: true,
      shareFiles: false,
      shareExternalLinks: true,
    };
    const now = new Date("2026-01-02T03:04:05.000Z");

    await repository.set(value, "operator-1", "enable channel", now);

    await expect(repository.get(value.guildId, value.channelId)).resolves.toEqual(value);
    const rows = await sql<{ summary: Record<string, unknown>; created_at: Date; category: string }[]>`
      select category, summary, created_at from audit_entries
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      category: "channel.capability.changed",
      created_at: now,
      summary: {
        actor: "operator-1",
        reason: "enable channel",
        guildId: value.guildId,
        channelId: value.channelId,
        before: denyAllCapabilities(value.guildId, value.channelId),
        after: value,
      },
    });
  });

  it("serializes concurrent first writes for one channel scope", async () => {
    const firstSql = createPostgresClient(process.env.TEST_DATABASE_URL!);
    const secondSql = createPostgresClient(process.env.TEST_DATABASE_URL!);
    const first = new PostgresChannelCapabilityRepository(firstSql);
    const second = new PostgresChannelCapabilityRepository(secondSql);
    const scope = { guildId: "concurrent-guild", channelId: "concurrent-channel" };
    const firstValue: ChannelCapabilities = {
      ...denyAllCapabilities(scope.guildId, scope.channelId),
      observeEvents: true,
    };
    const secondValue: ChannelCapabilities = {
      ...denyAllCapabilities(scope.guildId, scope.channelId),
      shareFiles: true,
    };
    const now = new Date("2026-01-02T03:04:05.000Z");

    try {
      await Promise.all([
        first.set(firstValue, "actor-1", "first", now),
        second.set(secondValue, "actor-2", "second", now),
      ]);

      const auditRows = await sql<
        { summary: { actor: string; before: ChannelCapabilities; after: ChannelCapabilities } }[]
      >`
        select summary from audit_entries where category = 'channel.capability.changed' order by id
      `;
      expect(auditRows).toHaveLength(2);
      const isDenyAll = (value: ChannelCapabilities) =>
        value.guildId === scope.guildId &&
        value.channelId === scope.channelId &&
        !value.observeEvents &&
        !value.respondToMentions &&
        !value.spontaneousJoin &&
        !value.spontaneousTopic &&
        !value.addReactions &&
        !value.createThreads &&
        !value.shareFiles &&
        !value.shareExternalLinks;
      const denyAllAudit = auditRows.filter((row) => isDenyAll(row.summary.before));
      expect(denyAllAudit).toHaveLength(1);
      const otherAudit = auditRows.find((row) => !isDenyAll(row.summary.before));
      expect(otherAudit?.summary.before).toEqual(
        expect.objectContaining({ guildId: scope.guildId, channelId: scope.channelId }),
      );
      expect(otherAudit?.summary.before).toEqual(denyAllAudit[0]?.summary.after);
      const finalValue = await first.get(scope.guildId, scope.channelId);
      expect(finalValue).toEqual(expect.anything());
      expect([firstValue, secondValue]).toContainEqual(finalValue);
      expect(auditRows.map((row) => row.summary.after)).toContainEqual(finalValue);
    } finally {
      await firstSql.end();
      await secondSql.end();
    }
  });

  it("merges concurrent patches and preserves the audit chain", async () => {
    const firstSql = createPostgresClient(process.env.TEST_DATABASE_URL!);
    const secondSql = createPostgresClient(process.env.TEST_DATABASE_URL!);
    const first = new PostgresChannelCapabilityRepository(firstSql);
    const second = new PostgresChannelCapabilityRepository(secondSql);
    const scope = { guildId: "patch-guild", channelId: "patch-channel" };
    const firstPatch: ChannelCapabilitiesPatch = { observeEvents: true };
    const secondPatch: ChannelCapabilitiesPatch = { shareFiles: true };
    const now = new Date("2026-01-02T03:04:05.000Z");

    try {
      const results = await Promise.all([
        first.patch(scope.guildId, scope.channelId, firstPatch, " actor-1 ", " first ", now),
        second.patch(scope.guildId, scope.channelId, secondPatch, "actor-2", "second", now),
      ]);
      const finalValue = await first.get(scope.guildId, scope.channelId);
      const auditRows = await sql<
        { summary: { before: ChannelCapabilities; after: ChannelCapabilities; actor: string; reason: string } }[]
      >`
        select summary from audit_entries where category = 'channel.capability.changed'
      `;

      expect(finalValue).toEqual({
        ...denyAllCapabilities(scope.guildId, scope.channelId),
        observeEvents: true,
        shareFiles: true,
      });
      expect(results).toContainEqual(finalValue);
      expect(auditRows).toHaveLength(2);
      const firstAudit = auditRows.find(
        (row) => row.summary.before.observeEvents === false && row.summary.before.shareFiles === false,
      );
      const secondAudit = auditRows.find((row) => row !== firstAudit);
      expect(firstAudit?.summary.before).toEqual(denyAllCapabilities(scope.guildId, scope.channelId));
      expect(secondAudit?.summary.before).toEqual(firstAudit?.summary.after);
      expect(secondAudit?.summary.after).toEqual(finalValue);
      expect(auditRows.map((row) => [row.summary.actor, row.summary.reason])).toEqual(
        expect.arrayContaining([
          ["actor-1", "first"],
          ["actor-2", "second"],
        ]),
      );
    } finally {
      await firstSql.end();
      await secondSql.end();
    }
  });

  it("uses patch arguments as scope and rejects invalid metadata", async () => {
    const repository = new PostgresChannelCapabilityRepository(sql);
    const now = new Date("2026-01-02T03:04:05.000Z");

    await expect(
      repository.patch("guild-1", "channel-1", { observeEvents: true }, " ", "reason", now),
    ).rejects.toThrow();
    await expect(
      repository.patch("guild-1", "channel-1", { observeEvents: true }, "actor", " ", now),
    ).rejects.toThrow();
    await expect(
      repository.patch("guild-1", "channel-1", { observeEvents: true }, "actor", "reason", new Date("invalid")),
    ).rejects.toThrow();
    await repository.patch("guild-1", "channel-1", { observeEvents: true }, " actor ", " reason ", now);
    await expect(repository.get("guild-2", "channel-2")).resolves.toEqual(denyAllCapabilities("guild-2", "channel-2"));
  });
});

describe("PostgresIngestionStore", () => {
  const now = new Date("2026-08-04T00:00:00.000Z");

  function canonicalEvent(overrides: Partial<CanonicalMessageEvent> = {}): CanonicalMessageEvent {
    return {
      id: crypto.randomUUID(),
      schemaVersion: 1,
      source: "discord",
      externalEventId: crypto.randomUUID(),
      externalVersion: "0",
      kind: "message.created",
      visibility: "observed",
      guildId: "g",
      channelId: "c",
      threadId: null,
      actorId: "u",
      actorKind: "human",
      occurredAt: now,
      receivedAt: now,
      content: { text: "hi", mentionedBot: true, mentionIds: [], replyToMessageId: null, attachments: [] },
      expiresAt: new Date("2026-09-04T00:00:00.000Z"),
      ...overrides,
    };
  }

  function enqueueDirective(
    event: CanonicalMessageEvent,
    availableAt: Date,
    firstTriggeredAt: Date,
  ): ConversationJobDirective {
    return {
      kind: "enqueue" as const,
      job: {
        id: crypto.randomUUID(),
        kind: "conversation_evaluate" as const,
        guildId: event.guildId,
        channelId: event.channelId,
        threadId: event.threadId,
        triggerEventId: event.id,
        priority: 100 as const,
        firstTriggeredAt,
        availableAt,
        maxWaitMs: 30_000,
        maxAttempts: 3 as const,
      },
    };
  }

  it("stores an event once and reports a duplicate without touching jobs", async () => {
    const store = new PostgresIngestionStore(sql);
    const event = canonicalEvent({
      content: {
        text: "hello",
        mentionedBot: true,
        mentionIds: ["bot-1"],
        replyToMessageId: null,
        attachments: [
          { id: "attachment-1", name: "a.txt", contentType: "text/plain", url: "https://example.test/a", size: 5 },
        ],
      },
    });
    await expect(store.saveEventAndSyncJob(event, { kind: "none" })).resolves.toEqual({
      eventId: event.id,
      duplicate: false,
      jobQueued: false,
      jobExtended: false,
    });
    const duplicate = canonicalEvent({
      externalEventId: event.externalEventId,
      externalVersion: event.externalVersion,
      content: { ...event.content, text: "ignored" },
    });
    await expect(store.saveEventAndSyncJob(duplicate, { kind: "none" })).resolves.toEqual({
      eventId: event.id,
      duplicate: true,
      jobQueued: false,
      jobExtended: false,
    });
    await expect(sql`select id, content from events`).resolves.toEqual([{ id: event.id, content: event.content }]);
    await expect(sql`select id from jobs`).resolves.toHaveLength(0);
  });

  it("creates one queued job per scope and extends it on a second mention", async () => {
    const store = new PostgresIngestionStore(sql);
    const first = canonicalEvent();
    const r1 = await store.saveEventAndSyncJob(first, enqueueDirective(first, new Date("2026-08-04T00:00:08Z"), now));
    expect(r1).toMatchObject({ jobQueued: true, jobExtended: false });

    const second = canonicalEvent({ receivedAt: new Date("2026-08-04T00:00:05Z") });
    const r2 = await store.saveEventAndSyncJob(
      second,
      enqueueDirective(second, new Date("2026-08-04T00:00:13Z"), new Date("2026-08-04T00:00:05Z")),
    );
    expect(r2).toMatchObject({ jobQueued: false, jobExtended: true });

    const jobs = await sql<{ trigger_event_id: string; first_triggered_at: Date; available_at: Date }[]>`
      select trigger_event_id, first_triggered_at, available_at from jobs where state = 'queued'
    `;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ trigger_event_id: first.id, first_triggered_at: now });
    expect(jobs[0]!.available_at).toEqual(new Date("2026-08-04T00:00:13Z"));
  });

  it("caps the extension at first_triggered_at + maxWait", async () => {
    const store = new PostgresIngestionStore(sql);
    const first = canonicalEvent();
    await store.saveEventAndSyncJob(first, enqueueDirective(first, new Date("2026-08-04T00:00:08Z"), now));
    const late = canonicalEvent({
      content: { text: "追記", mentionedBot: false, mentionIds: [], replyToMessageId: null, attachments: [] },
    });
    const result = await store.saveEventAndSyncJob(late, {
      kind: "extend",
      extension: {
        guildId: "g",
        channelId: "c",
        threadId: null,
        availableAt: new Date("2026-08-04T00:00:36Z"),
        maxWaitMs: 30_000,
        now: new Date("2026-08-04T00:00:28Z"),
      },
    });
    expect(result).toMatchObject({ jobExtended: true });
    const jobs = await sql<{ available_at: Date }[]>`select available_at from jobs where state = 'queued'`;
    expect(jobs[0]!.available_at).toEqual(new Date("2026-08-04T00:00:30Z"));
  });

  it("keeps thread scopes separate and reports no extension without a queued job", async () => {
    const store = new PostgresIngestionStore(sql);
    const threadEvent = canonicalEvent({ threadId: "t1" });
    const r1 = await store.saveEventAndSyncJob(
      threadEvent,
      enqueueDirective(threadEvent, new Date("2026-08-04T00:00:08Z"), now),
    );
    expect(r1).toMatchObject({ jobQueued: true });
    const parentEvent = canonicalEvent();
    const r2 = await store.saveEventAndSyncJob(parentEvent, {
      kind: "extend",
      extension: {
        guildId: "g",
        channelId: "c",
        threadId: null,
        availableAt: new Date("2026-08-04T00:00:09Z"),
        maxWaitMs: 30_000,
        now,
      },
    });
    expect(r2).toMatchObject({ jobExtended: false });
    const parentMention = canonicalEvent();
    const r3 = await store.saveEventAndSyncJob(
      parentMention,
      enqueueDirective(parentMention, new Date("2026-08-04T00:00:08Z"), now),
    );
    expect(r3).toMatchObject({ jobQueued: true });
  });

  it("does not touch jobs for a duplicate event", async () => {
    const store = new PostgresIngestionStore(sql);
    const event = canonicalEvent();
    await store.saveEventAndSyncJob(event, enqueueDirective(event, new Date("2026-08-04T00:00:08Z"), now));
    const dup = canonicalEvent({
      externalEventId: event.externalEventId,
      externalVersion: event.externalVersion,
    });
    const result = await store.saveEventAndSyncJob(dup, enqueueDirective(dup, new Date("2026-08-04T00:00:20Z"), now));
    expect(result).toMatchObject({ duplicate: true, jobQueued: false, jobExtended: false });
    const jobs = await sql<{ available_at: Date }[]>`select available_at from jobs`;
    expect(jobs[0]!.available_at).toEqual(new Date("2026-08-04T00:00:08Z"));
  });

  it("never pulls available_at backwards", async () => {
    const store = new PostgresIngestionStore(sql);
    const first = canonicalEvent();
    await store.saveEventAndSyncJob(first, enqueueDirective(first, new Date("2026-08-04T00:00:08Z"), now));
    const second = canonicalEvent({ receivedAt: new Date("2026-08-04T00:00:05Z") });
    await store.saveEventAndSyncJob(
      second,
      enqueueDirective(second, new Date("2026-08-04T00:00:13Z"), new Date("2026-08-04T00:00:05Z")),
    );
    const late = canonicalEvent();
    const result = await store.saveEventAndSyncJob(late, {
      kind: "extend",
      extension: {
        guildId: "g",
        channelId: "c",
        threadId: null,
        availableAt: new Date("2026-08-04T00:00:10Z"),
        maxWaitMs: 30_000,
        now: new Date("2026-08-04T00:00:02Z"),
      },
    });
    expect(result).toMatchObject({ jobExtended: true });
    await expect(sql`select available_at from jobs where state = 'queued'`).resolves.toEqual([
      { available_at: new Date("2026-08-04T00:00:13Z") },
    ]);
  });

  it("extends a queued job out of band and reports a missing scope", async () => {
    const store = new PostgresIngestionStore(sql);
    const event = canonicalEvent();
    await store.saveEventAndSyncJob(event, enqueueDirective(event, new Date("2026-08-04T00:00:08Z"), now));
    await expect(
      store.extendQueuedJob({
        guildId: "g",
        channelId: "c",
        threadId: null,
        availableAt: new Date("2026-08-04T00:00:11Z"),
        maxWaitMs: 30_000,
        now: new Date("2026-08-04T00:00:03Z"),
      }),
    ).resolves.toBe(true);
    await expect(sql`select available_at from jobs where state = 'queued'`).resolves.toEqual([
      { available_at: new Date("2026-08-04T00:00:11Z") },
    ]);
    await expect(
      store.extendQueuedJob({
        guildId: "g",
        channelId: "other",
        threadId: null,
        availableAt: new Date("2026-08-04T00:00:11Z"),
        maxWaitMs: 30_000,
        now: new Date("2026-08-04T00:00:03Z"),
      }),
    ).resolves.toBe(false);
  });
});
