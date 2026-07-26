import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Sql, TransactionSql } from "postgres";

export interface MigrationStatus {
  version: string;
  name: string;
  checksum: string;
  state: "applied" | "pending";
}

export interface MigrationApplyContext {
  actor: string;
  backupConfirmedAt: Date;
}

export interface MigrationRunResult {
  appliedVersions: string[];
  appliedAt: Date;
}

interface MigrationFile extends MigrationStatus {
  sql: string;
}

interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
}

async function loadMigrations(directory: string): Promise<MigrationFile[]> {
  const names = (await readdir(directory)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name)).sort();
  const migrations = await Promise.all(
    names.map(async (fileName) => {
      const match = /^(\d{4})_([a-z0-9_]+)\.sql$/u.exec(fileName);
      if (!match) throw new Error(`Invalid migration file name: ${fileName}`);
      const sql = await readFile(join(directory, fileName), "utf8");
      return {
        version: match[1]!,
        name: match[2]!,
        checksum: createHash("sha256").update(sql).digest("hex"),
        state: "pending" as const,
        sql,
      };
    }),
  );
  const versions = new Set<string>();
  for (const migration of migrations) {
    if (versions.has(migration.version)) throw new Error(`Duplicate migration version: ${migration.version}`);
    versions.add(migration.version);
  }
  return migrations;
}

async function ensureMigrationTable(sql: Sql | TransactionSql): Promise<void> {
  await sql`
    create table if not exists schema_migrations (
      version text primary key,
      name text not null,
      checksum text not null,
      applied_at timestamptz not null
    )
  `;
}

function validateHistory(files: MigrationFile[], rows: AppliedMigration[]): Map<string, AppliedMigration> {
  const localVersions = new Set(files.map((file) => file.version));
  for (const row of rows) {
    if (!localVersions.has(row.version)) throw new Error(`Migration history contains unknown version: ${row.version}`);
  }
  return new Map(rows.map((row) => [row.version, row]));
}

function validateMigration(file: MigrationFile, existing: AppliedMigration): void {
  if (existing.name !== file.name) throw new Error(`Migration name mismatch: ${file.version}`);
  if (existing.checksum !== file.checksum) throw new Error(`Migration checksum mismatch: ${file.version}`);
}

const MAX_BACKUP_AGE_MS = 24 * 60 * 60 * 1000;

function validateApplyContext(context: MigrationApplyContext): void {
  if (!context.actor.trim()) throw new Error("Migration actor must not be blank");
  if (!Number.isFinite(context.backupConfirmedAt.getTime())) throw new Error("Migration backup date is invalid");
}

export async function migrationStatus(sql: Sql, directory: string): Promise<MigrationStatus[]> {
  const files = await loadMigrations(directory);
  const relation = await sql<{ exists: boolean }[]>`
    select to_regclass('public.schema_migrations') is not null as exists
  `;
  if (!relation[0]?.exists)
    return files.map(({ version, name, checksum }) => ({ version, name, checksum, state: "pending" }));
  const rows = await sql<AppliedMigration[]>`
    select version, name, checksum from schema_migrations order by version
  `;
  const applied = validateHistory(files, rows);
  return files.map(({ version, name, checksum }) => {
    const existing = applied.get(version);
    if (existing !== undefined) validateMigration({ version, name, checksum, state: "pending", sql: "" }, existing);
    return { version, name, checksum, state: existing !== undefined ? "applied" : "pending" };
  });
}

export async function runMigrations(
  sql: Sql,
  directory: string,
  context: MigrationApplyContext,
): Promise<MigrationRunResult> {
  validateApplyContext(context);
  const files = await loadMigrations(directory);
  return sql.begin(async (transaction) => {
    await transaction`select pg_advisory_xact_lock(84623817)`;
    const lockTimeRows = await transaction<{ now: Date }[]>`select clock_timestamp() as now`;
    const lockTime = lockTimeRows[0]!.now;
    const backupAgeMs = lockTime.getTime() - context.backupConfirmedAt.getTime();
    if (backupAgeMs < 0 || backupAgeMs > MAX_BACKUP_AGE_MS) throw new Error("Migration backup confirmation is too old");
    await ensureMigrationTable(transaction);
    const rows = await transaction<AppliedMigration[]>`
      select version, name, checksum from schema_migrations order by version
    `;
    const applied = validateHistory(files, rows);
    const appliedVersions: string[] = [];
    for (const file of files) {
      const existing = applied.get(file.version);
      if (existing !== undefined) {
        validateMigration(file, existing);
        continue;
      }
      await transaction.unsafe(file.sql);
      await transaction`
        insert into schema_migrations (version, name, checksum, applied_at)
        values (${file.version}, ${file.name}, ${file.checksum}, clock_timestamp())
      `;
      appliedVersions.push(file.version);
    }
    const appliedAtRows = await transaction<{ now: Date }[]>`select clock_timestamp() as now`;
    const appliedAt = appliedAtRows[0]!.now;
    await transaction`
      insert into audit_entries (id, category, summary, created_at)
      values (
        ${randomUUID()},
        'migration.applied',
        ${transaction.json({ actor: context.actor, backupConfirmedAt: context.backupConfirmedAt, appliedVersions })},
        ${appliedAt}
      )
    `;
    return { appliedVersions, appliedAt };
  });
}
