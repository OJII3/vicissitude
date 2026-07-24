import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createPostgresClient } from "../../../src/adapters/postgres/client.js";
import { runMigrations } from "../../../src/adapters/postgres/migrations.js";
import { denyAllCapabilities, type ChannelCapabilities } from "../../../src/modules/channels/channel-capability.js";
import type { CanonicalMessageEvent } from "../../../src/modules/events/canonical-event.js";
import type { MentionResponseJobInput } from "../../../src/modules/events/ingest-message.js";
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
  await sql`truncate audit_entries, effects, model_calls, decision_runs, jobs, events, channel_capabilities cascade`;
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
  it("stores an event and queues only the first event for a duplicate key", async () => {
    const store = new PostgresIngestionStore(sql);
    const event: CanonicalMessageEvent = {
      id: "11111111-1111-4111-8111-111111111111",
      schemaVersion: 1,
      source: "discord",
      externalEventId: "external-1",
      externalVersion: "version-1",
      kind: "message.created",
      visibility: "observed",
      guildId: "guild-1",
      channelId: "channel-1",
      threadId: null,
      actorId: "actor-1",
      actorKind: "human",
      occurredAt: new Date("2026-01-02T03:00:00.000Z"),
      receivedAt: new Date("2026-01-02T03:04:05.000Z"),
      content: {
        text: "hello",
        mentionedBot: true,
        mentionIds: ["bot-1"],
        replyToMessageId: null,
        attachments: [
          { id: "attachment-1", name: "a.txt", contentType: "text/plain", url: "https://example.test/a", size: 5 },
        ],
      },
      expiresAt: new Date("2026-02-01T03:04:05.000Z"),
    };
    const job: MentionResponseJobInput = {
      id: "22222222-2222-4222-8222-222222222222",
      kind: "mention_response",
      eventId: event.id,
      priority: 100,
      availableAt: event.receivedAt,
      maxAttempts: 3,
    };
    const duplicateEvent = {
      ...event,
      id: "33333333-3333-4333-8333-333333333333",
      content: { ...event.content, text: "ignored" },
    };

    await expect(store.saveEventAndMaybeEnqueue(event, job)).resolves.toEqual({ eventId: event.id, duplicate: false });
    await expect(
      store.saveEventAndMaybeEnqueue(duplicateEvent, {
        ...job,
        id: "44444444-4444-4444-8444-444444444444",
        eventId: duplicateEvent.id,
      }),
    ).resolves.toEqual({ eventId: event.id, duplicate: true });

    await expect(sql`select id, content from events`).resolves.toEqual([{ id: event.id, content: event.content }]);
    await expect(
      sql`select id, kind, event_id, priority, state, available_at, attempts, max_attempts, created_at, updated_at from jobs`,
    ).resolves.toEqual([
      {
        id: job.id,
        kind: job.kind,
        event_id: event.id,
        priority: 100,
        state: "queued",
        available_at: job.availableAt,
        attempts: 0,
        max_attempts: 3,
        created_at: event.receivedAt,
        updated_at: event.receivedAt,
      },
    ]);
  });
});
