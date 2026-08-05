import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sql } from "postgres";
import { createPostgresClient } from "../../../src/adapters/postgres/client.js";
import { migrationStatus, runMigrations } from "../../../src/adapters/postgres/migrations.js";

let sql: Sql;

function assertMigrationContextRequired(enabled: boolean): void {
  if (enabled) {
    // @ts-expect-error migration application requires an explicit audit context
    void runMigrations(sql, "migrations");
  }
}

assertMigrationContextRequired(false);

beforeAll(async () => {
  sql = createPostgresClient(process.env.TEST_DATABASE_URL!);
  await sql`drop schema public cascade`;
  await sql`create schema public`;
});

afterAll(async () => {
  await sql.end();
});

describe("versioned migrations", () => {
  it("applies each migration once and records its checksum", async () => {
    const first = await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
      actor: "test-bootstrap",
      backupConfirmedAt: new Date(),
    });
    const second = await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
      actor: "test-bootstrap",
      backupConfirmedAt: new Date(),
    });
    expect(first).toMatchObject({ appliedVersions: ["0001", "0002", "0003"] });
    expect(second).toMatchObject({ appliedVersions: [] });
    expect(first.appliedAt).toBeInstanceOf(Date);

    const status = await migrationStatus(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!);
    expect(status).toEqual([
      expect.objectContaining({ version: "0001", name: "durable_spine", state: "applied" }),
      expect.objectContaining({ version: "0002", name: "thread_scope", state: "applied" }),
      expect.objectContaining({ version: "0003", name: "conversation_evaluate", state: "applied" }),
    ]);
    expect(status[0]?.checksum).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects an applied migration with an empty checksum", async () => {
    const rows = await sql<{ checksum: string }[]>`
      select checksum from schema_migrations where version = '0001'
    `;
    const checksum = rows[0]?.checksum;
    expect(checksum).toMatch(/^[0-9a-f]{64}$/u);

    await sql`update schema_migrations set checksum = '' where version = '0001'`;
    try {
      await expect(migrationStatus(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!)).rejects.toThrow(
        "Migration checksum mismatch: 0001",
      );
    } finally {
      await sql`update schema_migrations set checksum = ${checksum!} where version = '0001'`;
    }
  });

  it("serializes concurrent migration runs and records one history row", async () => {
    const first = createPostgresClient(process.env.TEST_DATABASE_URL!);
    const second = createPostgresClient(process.env.TEST_DATABASE_URL!);
    try {
      await sql`drop schema public cascade`;
      await sql`create schema public`;
      const [firstResult, secondResult] = (await Promise.all([
        runMigrations(first, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
          actor: "first",
          backupConfirmedAt: new Date(),
        }),
        runMigrations(second, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
          actor: "second",
          backupConfirmedAt: new Date(),
        }),
      ])) as [{ appliedVersions: string[] }, { appliedVersions: string[] }];
      expect([firstResult.appliedVersions, secondResult.appliedVersions].sort((a, b) => a.length - b.length)).toEqual([
        [],
        ["0001", "0002", "0003"],
      ]);
      const rows = await sql`select version from schema_migrations where version = '0001'`;
      expect(rows).toHaveLength(1);
      const audits = await sql`select id from audit_entries where category = 'migration.applied'`;
      expect(audits).toHaveLength(2);
    } finally {
      await first.end();
      await second.end();
      await sql`drop schema public cascade`;
      await sql`create schema public`;
    }
  });

  it("rejects database-only migration history", async () => {
    await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
      actor: "test-bootstrap",
      backupConfirmedAt: new Date(),
    });
    await sql`
      insert into schema_migrations (version, name, checksum, applied_at)
      values ('9999', 'missing_local', 'checksum', now())
    `;
    try {
      await expect(migrationStatus(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!)).rejects.toThrow(
        "Migration history contains unknown version: 9999",
      );
    } finally {
      await sql`delete from schema_migrations where version = '9999'`;
    }
  });

  it("rejects a migration history name mismatch", async () => {
    await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
      actor: "test-bootstrap",
      backupConfirmedAt: new Date(),
    });
    const rows = await sql<{ checksum: string }[]>`
      select checksum from schema_migrations where version = '0001'
    `;
    await sql`update schema_migrations set name = 'wrong_name' where version = '0001'`;
    try {
      await expect(migrationStatus(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!)).rejects.toThrow(
        "Migration name mismatch: 0001",
      );
    } finally {
      await sql`update schema_migrations set name = 'durable_spine', checksum = ${rows[0]!.checksum} where version = '0001'`;
    }
  });

  it("rejects duplicate migration versions in a temporary directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vicissitude-migrations-"));
    try {
      await sql`drop schema public cascade`;
      await sql`create schema public`;
      await writeFile(join(directory, "0001_first.sql"), "select 1;");
      await writeFile(join(directory, "0001_second.sql"), "select 2;");
      await expect(migrationStatus(sql, directory)).rejects.toThrow("Duplicate migration version: 0001");
    } finally {
      await rm(directory, { recursive: true, force: true });
      await sql`drop schema public cascade`;
      await sql`create schema public`;
    }
  });

  it("returns applied versions and records an admin audit for an explicit context", async () => {
    await sql`drop schema public cascade`;
    await sql`create schema public`;
    const backupConfirmedAt = new Date();
    const result = (await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
      actor: "admin@example.com",
      backupConfirmedAt,
    }))!;
    expect(result.appliedVersions).toEqual(["0001", "0002", "0003"]);
    expect(result.appliedAt).toBeInstanceOf(Date);
    const rows = await sql<{ summary: { actor: string; backupConfirmedAt: string; appliedVersions: string[] } }[]>`
      select summary from audit_entries where category = 'migration.applied'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.summary).toMatchObject({ actor: "admin@example.com", appliedVersions: ["0001", "0002", "0003"] });
    expect(new Date(rows[0]!.summary.backupConfirmedAt).getTime()).toBe(backupConfirmedAt.getTime());
  });

  it("audits an explicit no-op with no applied versions", async () => {
    await sql`drop schema public cascade`;
    await sql`create schema public`;
    const context = { actor: "admin@example.com", backupConfirmedAt: new Date() };
    const first = (await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, context))!;
    const second = (await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, context))!;
    expect(first.appliedVersions).toEqual(["0001", "0002", "0003"]);
    expect(second.appliedVersions).toEqual([]);
    const rows = await sql<{ summary: { appliedVersions: string[] } }[]>`
      select summary from audit_entries where category = 'migration.applied' order by created_at
    `;
    expect(rows.at(-1)?.summary.appliedVersions).toEqual([]);
  });

  it.each([
    ["blank actor", { actor: " ", backupConfirmedAt: new Date() }],
    ["invalid date", { actor: "admin", backupConfirmedAt: new Date(Number.NaN) }],
  ])("rejects context with %s before creating migration tables", async (_label, context) => {
    await sql`drop schema public cascade`;
    await sql`create schema public`;
    await expect(runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, context)).rejects.toThrow();
    const tables = await sql<{ exists: boolean }[]>`
      select to_regclass('public.schema_migrations') is not null as exists
    `;
    expect(tables[0]?.exists).toBe(false);
  });

  it("revalidates backup age after waiting for the migration lock", async () => {
    await sql`drop schema public cascade`;
    await sql`create schema public`;
    const locker = createPostgresClient(process.env.TEST_DATABASE_URL!);
    let lockAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => {
      lockAcquired = resolve;
    });
    const lock = locker.begin(async (transaction) => {
      await transaction`select pg_advisory_xact_lock(84623817)`;
      lockAcquired();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    });
    try {
      await acquired;
      await expect(
        runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
          actor: "admin",
          backupConfirmedAt: new Date(Date.now() - 24 * 60 * 60 * 1000 + 500),
        }),
      ).rejects.toThrow(/backup confirmation is too old/u);
    } finally {
      await lock;
      await locker.end();
    }
  });

  it("records applied_at after an advisory lock is released", async () => {
    await sql`drop schema public cascade`;
    await sql`create schema public`;
    const locker = createPostgresClient(process.env.TEST_DATABASE_URL!);
    let lockAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => {
      lockAcquired = resolve;
    });
    const lock = locker.begin(async (transaction) => {
      await transaction`select pg_advisory_xact_lock(84623817)`;
      lockAcquired();
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    await acquired;
    const applying = runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
      actor: "test-lock-release",
      backupConfirmedAt: new Date(),
    });
    await lock;
    const releasedAt = new Date();
    await applying;
    const rows = await sql<{ applied_at: Date }[]>`select applied_at from schema_migrations where version = '0001'`;
    await locker.end();
    expect(rows[0]!.applied_at.getTime()).toBeGreaterThanOrEqual(releasedAt.getTime());
  });

  it("creates the thread override table with an all-inherit guard and the thread-aware event index", async () => {
    await sql`drop schema public cascade`;
    await sql`create schema public`;
    await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
      actor: "test-bootstrap",
      backupConfirmedAt: new Date(),
    });

    const columns = await sql<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable from information_schema.columns
      where table_name = 'thread_capability_overrides'
        and column_name in ('observe_events', 'respond_to_mentions', 'add_reactions')
      order by column_name
    `;
    expect(columns).toEqual([
      { column_name: "add_reactions", is_nullable: "YES" },
      { column_name: "observe_events", is_nullable: "YES" },
      { column_name: "respond_to_mentions", is_nullable: "YES" },
    ]);

    const indexes = await sql<{ indexname: string }[]>`
      select indexname from pg_indexes where tablename = 'events' and indexname = 'events_thread_scope_time_idx'
    `;
    expect(indexes).toHaveLength(1);

    await expect(
      sql`
        insert into thread_capability_overrides (guild_id, channel_id, thread_id, updated_at, updated_by, reason)
        values ('guild-1', 'channel-1', 'thread-1', now(), 'test', 'all inherit')
      `,
    ).rejects.toThrow();
  });

  it("adds a nullable thread_id column to effects", async () => {
    await sql`drop schema public cascade`;
    await sql`create schema public`;
    await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
      actor: "test-bootstrap",
      backupConfirmedAt: new Date(),
    });

    const columns = await sql<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable from information_schema.columns
      where table_name = 'effects' and column_name = 'thread_id'
    `;
    expect(columns).toEqual([{ column_name: "thread_id", is_nullable: "YES" }]);
  });

  it("creates the conversation batch tables and enforces one queued job per scope", async () => {
    await sql`drop schema public cascade`;
    await sql`create schema public`;
    await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
      actor: "test-bootstrap",
      backupConfirmedAt: new Date(),
    });

    const tables = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_name in ('conversation_cursors', 'run_input_events', 'actor_states') order by table_name
    `;
    expect(tables.map((table) => table.table_name)).toEqual([
      "actor_states",
      "conversation_cursors",
      "run_input_events",
    ]);

    const jobColumns = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_name = 'jobs'
        and column_name in ('event_id', 'guild_id', 'channel_id', 'thread_id', 'first_triggered_at', 'trigger_event_id')
      order by column_name
    `;
    expect(jobColumns.map((column) => column.column_name)).toEqual([
      "channel_id",
      "first_triggered_at",
      "guild_id",
      "thread_id",
      "trigger_event_id",
    ]);

    const now = new Date();
    await sql`insert into events (id, schema_version, source, external_event_id, external_version, kind, visibility, guild_id, channel_id, actor_id, actor_kind, occurred_at, received_at, content, expires_at) values ('00000000-0000-4000-8000-0000000000aa', 1, 'discord', 'scope-guard', '0', 'message.created', 'mention_only', 'g', 'c', 'a', 'human', ${now}, ${now}, ${sql.json({ text: "hi" })}, ${now})`;
    await sql`insert into jobs (id, kind, guild_id, channel_id, thread_id, trigger_event_id, state, available_at, first_triggered_at, created_at, updated_at) values ('00000000-0000-4000-8000-0000000000ab', 'conversation_evaluate', 'g', 'c', null, '00000000-0000-4000-8000-0000000000aa', 'queued', ${now}, ${now}, ${now}, ${now})`;
    await expect(
      sql`insert into jobs (id, kind, guild_id, channel_id, thread_id, trigger_event_id, state, available_at, first_triggered_at, created_at, updated_at) values ('00000000-0000-4000-8000-0000000000ac', 'conversation_evaluate', 'g', 'c', null, '00000000-0000-4000-8000-0000000000aa', 'queued', ${now}, ${now}, ${now}, ${now})`,
    ).rejects.toThrow(/jobs_scope_queued_idx/u);

    await sql`update jobs set state = 'succeeded' where id = '00000000-0000-4000-8000-0000000000ab'`;
    await sql`insert into jobs (id, kind, guild_id, channel_id, thread_id, trigger_event_id, state, available_at, first_triggered_at, created_at, updated_at) values ('00000000-0000-4000-8000-0000000000ac', 'conversation_evaluate', 'g', 'c', null, '00000000-0000-4000-8000-0000000000aa', 'queued', ${now}, ${now}, ${now}, ${now})`;
    await expect(sql`select count(*)::int as count from jobs where state = 'queued'`).resolves.toEqual([{ count: 1 }]);
  });
});
