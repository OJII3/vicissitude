import type { Sql } from "postgres";
import {
  CharacterDefinitionSchema,
  type CharacterDefinition,
  type CharacterDefinitionRepository,
} from "../../modules/characters/character-definition.js";

export class PostgresCharacterRepository implements CharacterDefinitionRepository {
  public constructor(private readonly sql: Sql) {}
  public async importDraft(definition: CharacterDefinition, actor: string, now: Date): Promise<void> {
    const parsed = CharacterDefinitionSchema.parse(definition);
    await this.sql.begin(async (tx) => {
      await tx`insert into character_definitions (character_id, version, status, definition, created_at, created_by) values (${parsed.characterId}, ${parsed.version}, 'draft', ${tx.json(parsed)}, ${now}, ${actor})`;
      await tx`insert into audit_entries (id, category, summary, created_at) values (gen_random_uuid(), 'character.imported', ${tx.json({ actor, characterId: parsed.characterId, version: parsed.version })}, ${now})`;
    });
  }
  public async activate(characterId: string, version: number, actor: string, now: Date): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${characterId}, 0))`;
      const target = await tx<
        { characterId: string; version: number; definition: unknown }[]
      >`select character_id as "characterId", version, definition from character_definitions where character_id=${characterId} and version=${version} for update`;
      if (!target[0]) throw new Error(`Character definition not found: ${characterId} v${version}`);
      const parsed = CharacterDefinitionSchema.parse(target[0].definition);
      if (parsed.characterId !== target[0].characterId || parsed.version !== target[0].version)
        throw new Error("Character definition identity corruption");
      const current = await tx<
        { version: number }[]
      >`select version from character_definitions where character_id=${characterId} and status='production' for update`;
      await tx`update character_definitions set status='retired' where character_id=${characterId} and status='production'`;
      await tx`update character_definitions set status='production' where character_id=${characterId} and version=${version}`;
      await tx`insert into audit_entries (id, category, summary, created_at) values (gen_random_uuid(), 'character.activated', ${tx.json({ actor, characterId, beforeVersion: current[0]?.version ?? null, afterVersion: version })}, ${now})`;
    });
  }
  public async getProduction(characterId: string): Promise<CharacterDefinition | null> {
    const rows = await this.sql<
      { characterId: string; version: number; definition: unknown }[]
    >`select character_id as "characterId", version, definition from character_definitions where character_id=${characterId} and status='production'`;
    if (!rows[0]) return null;
    const parsed = CharacterDefinitionSchema.parse(rows[0].definition);
    if (parsed.characterId !== rows[0].characterId || parsed.version !== rows[0].version)
      throw new Error("Character definition identity corruption");
    return parsed;
  }
}
