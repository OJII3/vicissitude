import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createPostgresClient } from "../../../src/adapters/postgres/client.js";
import { runMigrations } from "../../../src/adapters/postgres/migrations.js";
import { PostgresCharacterRepository } from "../../../src/adapters/postgres/character-repository.js";
import type { CharacterDefinition } from "../../../src/modules/characters/character-definition.js";

const now = new Date("2026-01-02T03:04:05.000Z");
const definition = (version: number): CharacterDefinition => ({
  schemaVersion: 1,
  characterId: "haru",
  version,
  name: "  春  ",
  language: "ja",
  systemPrompt: "  丁寧に答える  ",
  failureMessages: [" 失敗しました "],
});
let sql: Sql;
beforeAll(async () => {
  sql = createPostgresClient(process.env.TEST_DATABASE_URL!);
  await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
    actor: "test-bootstrap",
    backupConfirmedAt: new Date(),
  });
});
beforeEach(async () => {
  await sql`truncate character_definitions, audit_entries cascade`;
});
afterAll(async () => sql.end());
describe("PostgresCharacterRepository", () => {
  it("imports drafts, activates versions, retires previous production, and reads audits", async () => {
    const repo = new PostgresCharacterRepository(sql);
    await repo.importDraft(definition(1), "admin", now);
    expect(
      (await sql`select definition from character_definitions where character_id = 'haru' and version = 1`)[0]
        ?.definition,
    ).toMatchObject({ name: "春", systemPrompt: "丁寧に答える", failureMessages: ["失敗しました"] });
    await repo.activate("haru", 1, "admin", now);
    expect(await repo.getProduction("haru")).toMatchObject({ version: 1 });
    await repo.importDraft(definition(2), "admin", now);
    await repo.activate("haru", 2, "admin", now);
    expect(await repo.getProduction("haru")).toMatchObject({ version: 2 });
    expect(
      await sql`select version, status from character_definitions where character_id='haru' order by version`,
    ).toEqual([
      { version: 1, status: "retired" },
      { version: 2, status: "production" },
    ]);
    expect(
      await sql`select category from audit_entries where category like 'character.%' order by created_at`,
    ).toHaveLength(4);
    const audits = await sql<
      {
        category: string;
        summary: { actor: string; characterId: string; version?: number; afterVersion?: number };
        created_at: Date;
      }[]
    >`select category, summary, created_at from audit_entries where category like 'character.%' order by created_at`;
    expect(audits.map((audit) => audit.category)).toEqual([
      "character.imported",
      "character.activated",
      "character.imported",
      "character.activated",
    ]);
    expect(audits[0]?.summary).toMatchObject({ actor: "admin", characterId: "haru", version: 1 });
    expect(audits[1]?.summary).toMatchObject({ actor: "admin", characterId: "haru", afterVersion: 1 });
    expect(audits.every((audit) => audit.created_at instanceof Date)).toBe(true);
  });

  it("rejects invalid stored production JSON", async () => {
    const repo = new PostgresCharacterRepository(sql);
    await repo.importDraft(definition(1), "admin", now);
    await repo.activate("haru", 1, "admin", now);
    await sql`update character_definitions set definition = ${sql.json({ schemaVersion: 1 })} where character_id = 'haru' and status = 'production'`;
    await expect(repo.getProduction("haru")).rejects.toThrow();
  });

  it("rejects production JSON whose identity differs from the row", async () => {
    const repo = new PostgresCharacterRepository(sql);
    await repo.importDraft(definition(1), "admin", now);
    await repo.activate("haru", 1, "admin", now);
    await sql`update character_definitions set definition = ${sql.json({ ...definition(1), characterId: "other" })} where character_id = 'haru' and version = 1`;
    await expect(repo.getProduction("haru")).rejects.toThrow(/identity/i);
    await expect(repo.activate("haru", 1, "admin", now)).rejects.toThrow(/identity/i);
    expect(await sql`select status from character_definitions where character_id = 'haru' and version = 1`).toEqual([
      { status: "production" },
    ]);
    expect(await sql`select category from audit_entries where category like 'character.activated'`).toHaveLength(1);
  });

  it("rejects production JSON whose version differs from the row", async () => {
    const repo = new PostgresCharacterRepository(sql);
    await repo.importDraft(definition(1), "admin", now);
    await repo.activate("haru", 1, "admin", now);
    await sql`update character_definitions set definition = ${sql.json({ ...definition(1), version: 9 })} where character_id = 'haru' and version = 1`;
    await expect(repo.getProduction("haru")).rejects.toThrow(/identity/i);
    await expect(repo.activate("haru", 1, "admin", now)).rejects.toThrow(/identity/i);
    expect(await sql`select status from character_definitions where character_id = 'haru' and version = 1`).toEqual([
      { status: "production" },
    ]);
    expect(await sql`select category from audit_entries where category like 'character.activated'`).toHaveLength(1);
  });

  it("serializes concurrent activation of the same character", async () => {
    const repo = new PostgresCharacterRepository(sql);
    await repo.importDraft(definition(1), "admin", now);
    await repo.activate("haru", 1, "admin", now);
    await repo.importDraft(definition(2), "admin", now);
    await repo.importDraft(definition(3), "admin", now);
    await Promise.all([
      repo.activate("haru", 2, "a", new Date(now.getTime() + 1)),
      repo.activate("haru", 3, "b", new Date(now.getTime() + 2)),
    ]);
    const audits = await sql<
      { summary: { beforeVersion: number | null; afterVersion: number } }[]
    >`select summary from audit_entries where category = 'character.activated' order by created_at, id`;
    const chain = audits
      .slice(1)
      .map((row, index) => [row.summary.beforeVersion, audits[index + 1]!.summary.afterVersion]);
    expect(chain.every(([before], index) => index === 0 || before === chain[index - 1]![1])).toBe(true);
    expect(
      new Set(
        (await sql`select version from character_definitions where character_id='haru' and status='production'`).map(
          (row) => row.version,
        ),
      ),
    ).toHaveLength(1);
  });
});
