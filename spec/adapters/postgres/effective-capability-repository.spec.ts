import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createPostgresClient } from "../../../src/adapters/postgres/client.js";
import { runMigrations } from "../../../src/adapters/postgres/migrations.js";
import { denyAllCapabilities } from "../../../src/modules/channels/channel-capability.js";
import { PostgresChannelCapabilityRepository } from "../../../src/adapters/postgres/channel-capability-repository.js";
import { PostgresThreadCapabilityRepository } from "../../../src/adapters/postgres/thread-capability-repository.js";
import { PostgresEffectiveCapabilityRepository } from "../../../src/adapters/postgres/effective-capability-repository.js";

let sql: Sql;

beforeAll(async () => {
  sql = createPostgresClient(process.env.TEST_DATABASE_URL!);
  await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
    actor: "test-bootstrap",
    backupConfirmedAt: new Date(),
  });
});

beforeEach(async () => {
  await sql`truncate audit_entries, thread_capability_overrides, channel_capabilities cascade`;
});

afterAll(async () => {
  await sql.end();
});

const now = new Date("2026-01-02T03:04:05.000Z");

function build(): PostgresEffectiveCapabilityRepository {
  return new PostgresEffectiveCapabilityRepository(
    new PostgresChannelCapabilityRepository(sql),
    new PostgresThreadCapabilityRepository(sql),
  );
}

describe("PostgresEffectiveCapabilityRepository", () => {
  it("returns channel capabilities for a non-thread message", async () => {
    const channels = new PostgresChannelCapabilityRepository(sql);
    await channels.patch("guild-1", "channel-1", { observeEvents: true }, "operator", "enable", now);

    await expect(build().get("guild-1", "channel-1", null)).resolves.toMatchObject({ observeEvents: true });
  });

  it("inherits channel capabilities in a thread without an override", async () => {
    const channels = new PostgresChannelCapabilityRepository(sql);
    await channels.patch("guild-1", "channel-1", { observeEvents: true }, "operator", "enable", now);

    await expect(build().get("guild-1", "channel-1", "thread-1")).resolves.toMatchObject({ observeEvents: true });
  });

  it("applies a deny override inside an allowed channel", async () => {
    const channels = new PostgresChannelCapabilityRepository(sql);
    const threads = new PostgresThreadCapabilityRepository(sql);
    await channels.patch("guild-1", "channel-1", { observeEvents: true }, "operator", "enable", now);
    await threads.patch("guild-1", "channel-1", "thread-1", { observeEvents: false }, "operator", "quiet", now);

    await expect(build().get("guild-1", "channel-1", "thread-1")).resolves.toMatchObject({ observeEvents: false });
    await expect(build().get("guild-1", "channel-1", null)).resolves.toMatchObject({ observeEvents: true });
  });

  it("applies an allow override inside a denied channel", async () => {
    const threads = new PostgresThreadCapabilityRepository(sql);
    await threads.patch(
      "guild-1",
      "forum-1",
      "thread-1",
      { observeEvents: true, respondToMentions: true },
      "operator",
      "watch one thread",
      now,
    );

    await expect(build().get("guild-1", "forum-1", "thread-1")).resolves.toMatchObject({
      observeEvents: true,
      respondToMentions: true,
    });
    await expect(build().get("guild-1", "forum-1", null)).resolves.toEqual(denyAllCapabilities("guild-1", "forum-1"));
  });
});
