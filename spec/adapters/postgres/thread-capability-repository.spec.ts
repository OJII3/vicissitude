import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createPostgresClient } from "../../../src/adapters/postgres/client.js";
import { runMigrations } from "../../../src/adapters/postgres/migrations.js";
import { PostgresThreadCapabilityRepository } from "../../../src/adapters/postgres/thread-capability-repository.js";

let sql: Sql;

beforeAll(async () => {
  sql = createPostgresClient(process.env.TEST_DATABASE_URL!);
  await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
    actor: "test-bootstrap",
    backupConfirmedAt: new Date(),
  });
});

beforeEach(async () => {
  await sql`truncate audit_entries, thread_capability_overrides cascade`;
});

afterAll(async () => {
  await sql.end();
});

const now = new Date("2026-01-02T03:04:05.000Z");

describe("PostgresThreadCapabilityRepository", () => {
  it("returns null without writing a row for an unconfigured thread", async () => {
    const repository = new PostgresThreadCapabilityRepository(sql);

    await expect(repository.get("guild-1", "channel-1", "thread-1")).resolves.toBeNull();
    await expect(sql`select * from thread_capability_overrides`).resolves.toHaveLength(0);
  });

  it("stores an override and records the change audit", async () => {
    const repository = new PostgresThreadCapabilityRepository(sql);

    const result = await repository.patch(
      "guild-1",
      "channel-1",
      "thread-1",
      { observeEvents: true },
      "operator-1",
      "watch this thread",
      now,
    );

    expect(result).toEqual({
      guildId: "guild-1",
      channelId: "channel-1",
      threadId: "thread-1",
      observeEvents: true,
      respondToMentions: null,
      addReactions: null,
    });
    await expect(repository.get("guild-1", "channel-1", "thread-1")).resolves.toEqual(result);
    await expect(sql`select updated_by, reason, updated_at from thread_capability_overrides`).resolves.toEqual([
      { updated_by: "operator-1", reason: "watch this thread", updated_at: now },
    ]);
    const rows = await sql<{ category: string; summary: Record<string, unknown>; created_at: Date }[]>`
      select category, summary, created_at from audit_entries
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      category: "thread.capability.changed",
      created_at: now,
      summary: {
        actor: "operator-1",
        reason: "watch this thread",
        guildId: "guild-1",
        channelId: "channel-1",
        threadId: "thread-1",
        before: null,
        after: { observeEvents: true, respondToMentions: null, addReactions: null },
      },
    });
  });

  it("merges a patch into an existing override and leaves untouched fields alone", async () => {
    const repository = new PostgresThreadCapabilityRepository(sql);
    await repository.patch("guild-1", "channel-1", "thread-1", { observeEvents: true }, "operator-1", "first", now);

    const result = await repository.patch(
      "guild-1",
      "channel-1",
      "thread-1",
      { respondToMentions: false },
      "operator-2",
      "second",
      now,
    );

    expect(result).toMatchObject({ observeEvents: true, respondToMentions: false, addReactions: null });
  });

  it("deletes the row when every capability returns to inherit", async () => {
    const repository = new PostgresThreadCapabilityRepository(sql);
    await repository.patch("guild-1", "channel-1", "thread-1", { observeEvents: true }, "operator-1", "first", now);

    const result = await repository.patch(
      "guild-1",
      "channel-1",
      "thread-1",
      { observeEvents: null },
      "operator-1",
      "back to inherit",
      now,
    );

    expect(result).toBeNull();
    await expect(sql`select * from thread_capability_overrides`).resolves.toHaveLength(0);
    const rows = await sql<{ summary: { before: unknown; after: unknown } }[]>`
      select summary from audit_entries where category = 'thread.capability.changed' order by created_at
    `;
    expect(rows.at(-1)?.summary.after).toBeNull();
  });

  it("scopes overrides to a single thread", async () => {
    const repository = new PostgresThreadCapabilityRepository(sql);
    await repository.patch("guild-1", "channel-1", "thread-1", { observeEvents: true }, "operator-1", "one", now);

    await expect(repository.get("guild-1", "channel-1", "thread-2")).resolves.toBeNull();
    await expect(repository.get("guild-1", "channel-2", "thread-1")).resolves.toBeNull();
  });

  it("rejects invalid metadata", async () => {
    const repository = new PostgresThreadCapabilityRepository(sql);

    await expect(
      repository.patch("guild-1", "channel-1", "thread-1", { observeEvents: true }, " ", "reason", now),
    ).rejects.toThrow();
    await expect(
      repository.patch("guild-1", "channel-1", "thread-1", { observeEvents: true }, "actor", " ", now),
    ).rejects.toThrow();
    await expect(
      repository.patch("guild-1", "channel-1", "thread-1", { observeEvents: true }, "actor", "reason", new Date("x")),
    ).rejects.toThrow();
  });

  it("merges concurrent patches for one thread scope", async () => {
    const firstSql = createPostgresClient(process.env.TEST_DATABASE_URL!);
    const secondSql = createPostgresClient(process.env.TEST_DATABASE_URL!);
    const first = new PostgresThreadCapabilityRepository(firstSql);
    const second = new PostgresThreadCapabilityRepository(secondSql);

    try {
      await Promise.all([
        first.patch("guild-1", "channel-1", "thread-1", { observeEvents: true }, "actor-1", "first", now),
        second.patch("guild-1", "channel-1", "thread-1", { addReactions: true }, "actor-2", "second", now),
      ]);

      await expect(first.get("guild-1", "channel-1", "thread-1")).resolves.toMatchObject({
        observeEvents: true,
        addReactions: true,
      });
      const audits = await sql`select id from audit_entries where category = 'thread.capability.changed'`;
      expect(audits).toHaveLength(2);
    } finally {
      await firstSql.end();
      await secondSql.end();
    }
  });
});
