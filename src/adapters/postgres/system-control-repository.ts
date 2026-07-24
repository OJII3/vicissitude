import type { Sql } from "postgres";
import type { SystemMode, SystemState } from "../../modules/system/system-control.js";

export class PostgresSystemControlRepository {
  public constructor(private readonly sql: Sql) {}

  public async get(): Promise<SystemState> {
    const rows = await this.sql<
      SystemState[]
    >`select mode, updated_at as "updatedAt", updated_by as "updatedBy", reason from system_state where singleton`;
    if (!rows[0]) throw new Error("System state singleton is missing");
    return rows[0];
  }

  public async setMode(mode: SystemMode, actor: string, reason: string, now: Date): Promise<SystemState> {
    if (!actor.trim() || !reason.trim()) throw new Error("Actor and reason are required");
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("now must be a valid date");
    return this.sql.begin(async (transaction) => {
      const rows = await transaction<
        SystemState[]
      >`select mode, updated_at as "updatedAt", updated_by as "updatedBy", reason from system_state where singleton for update`;
      if (!rows[0]) throw new Error("System state singleton is missing");
      const before = rows[0].mode;
      const updated = (
        await transaction<
          SystemState[]
        >`update system_state set mode = ${mode}, updated_at = ${now}, updated_by = ${actor}, reason = ${reason} where singleton returning mode, updated_at as "updatedAt", updated_by as "updatedBy", reason`
      )[0]!;
      await transaction`insert into audit_entries (id, category, summary, created_at) values (gen_random_uuid(), 'system.mode.changed', ${transaction.json({ actor, reason, before, after: mode })}, ${now})`;
      return updated;
    });
  }
}
