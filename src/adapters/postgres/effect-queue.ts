import type { Sql } from "postgres";
import { DiscordReplyPayloadSchema, type ClaimedReplyEffect, type EffectState } from "../../modules/effects/effect.js";
import { newId } from "../../shared/ids.js";

const bounded = (value: string) => value.slice(0, 2000);
const safeCodes = new Set([
  "discord_request_failed",
  "discord_delivery_unknown",
  "effect_state_persistence_failed",
  "invalid_effect_payload",
  "capability_revoked",
  "executor_restart_recovery",
]);
const safeCode = (value: string) => (safeCodes.has(value) ? value : "effect_execution_failed");
const date = (value: Date, name: string) => {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(`${name} must be a valid date`);
};
const actor = (value: string, name: string) => {
  if (!value.trim()) throw new Error(`${name} is required`);
};
export interface EffectInspection {
  id: string;
  runId: string;
  effectSlot: string;
  kind: "discord.reply";
  state: EffectState;
  guildId: string;
  capabilityChannelId: string;
  targetChannelId: string;
  threadId: string | null;
  targetMessageId: string;
  content: string;
  allowedMentions: { parse: []; repliedUser: false };
  externalResourceId: string | null;
  executorId: string | null;
  attempts: number;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  capabilityDecision: Record<string, unknown>;
}

export class PostgresEffectQueue {
  public constructor(private readonly sql: Sql) {}
  public async claim(workerId: string, now: Date): Promise<ClaimedReplyEffect | null> {
    actor(workerId, "Worker ID");
    date(now, "now");
    return this.sql.begin(async (tx) => {
      const mode = await tx<{ mode: string }[]>`select mode from system_state where singleton for share`;
      if (!mode[0]) throw new Error("System state singleton is missing");
      if (mode[0].mode === "stopped") return null;
      const rows = await tx<
        (ClaimedReplyEffect & { payload: unknown })[]
      >`with candidate as (select id from effects where state='planned' order by created_at for update skip locked limit 1) update effects e set state='executing', executor_id=${workerId}, attempts=e.attempts+1, updated_at=${now} from candidate c where e.id=c.id returning e.id, e.run_id as "runId", e.guild_id as "guildId", e.capability_channel_id as "capabilityChannelId", e.target_channel_id as "targetChannelId", e.thread_id as "threadId", e.target_message_id as "targetMessageId", e.attempts, e.payload`;
      const row = rows[0];
      if (!row) return null;
      try {
        const payload = DiscordReplyPayloadSchema.parse(row.payload);
        return { ...row, content: payload.content };
      } catch {
        await tx`update effects set state='failed', error='invalid_effect_payload', updated_at=${now} where id=${row.id} and state='executing'`;
        await tx`insert into audit_entries (id,category,run_id,effect_id,summary,created_at) values (${newId()},'effect.failed',${row.runId},${row.id},${tx.json({ error: "invalid_effect_payload" })},${now})`;
        return null;
      }
    });
  }
  private async transition(
    id: string,
    expected: EffectState,
    state: EffectState,
    now: Date,
    error: string | null,
    externalResourceId: string | null,
    category: string,
    summary: Record<string, string | null>,
  ): Promise<void> {
    date(now, "now");
    await this.sql.begin(async (tx) => {
      const rows = await tx<
        { run_id: string }[]
      >`update effects set state=${state}, error=${error ? bounded(safeCode(error)) : null}, external_resource_id=${externalResourceId}, updated_at=${now} where id=${id} and state=${expected} returning run_id`;
      if (!rows[0]) throw new Error(`Invalid effect transition: ${expected} -> ${state}`);
      await tx`insert into audit_entries (id,category,run_id,effect_id,summary,created_at) values (${newId()},${category},${rows[0].run_id},${id},${tx.json(summary)},${now})`;
    });
  }
  public succeed(id: string, externalResourceId: string, now: Date) {
    actor(externalResourceId, "External resource ID");
    return this.transition(id, "executing", "succeeded", now, null, externalResourceId, "effect.succeeded", {
      externalResourceId,
    });
  }
  public fail(id: string, error: string, now: Date) {
    return this.transition(id, "executing", "failed", now, error, null, "effect.failed", { error: safeCode(error) });
  }
  public markUnknown(id: string, error: string, now: Date) {
    return this.transition(id, "executing", "unknown", now, error, null, "effect.unknown", { error: safeCode(error) });
  }
  public async recoverExecutingAsUnknown(now: Date): Promise<number> {
    date(now, "now");
    return this.sql.begin(async (tx) => {
      const rows = await tx<
        { id: string; run_id: string }[]
      >`update effects set state='unknown', error='executor_restart_recovery', updated_at=${now} where state='executing' returning id, run_id`;
      for (const row of rows)
        await tx`insert into audit_entries (id,category,run_id,effect_id,summary,created_at) values (${newId()},'effect.unknown',${row.run_id},${row.id},${tx.json({ error: "executor_restart_recovery" })},${now})`;
      return rows.length;
    });
  }
  public async get(id: string): Promise<{ state: EffectState; externalResourceId: string | null }> {
    const rows = await this.sql<
      { state: EffectState; externalResourceId: string | null }[]
    >`select state, external_resource_id as "externalResourceId" from effects where id=${id}`;
    if (!rows[0]) throw new Error("Effect not found");
    return rows[0];
  }
  public async inspect(id: string): Promise<EffectInspection> {
    const rows = await this.sql<
      {
        id: string;
        runId: string;
        effectSlot: string;
        kind: string;
        state: EffectState;
        guildId: string;
        capabilityChannelId: string;
        targetChannelId: string;
        threadId: string | null;
        targetMessageId: string;
        externalResourceId: string | null;
        executorId: string | null;
        attempts: number;
        error: string | null;
        createdAt: Date;
        updatedAt: Date;
        payload: unknown;
        capabilityDecision: unknown;
      }[]
    >`select id,run_id as "runId",effect_slot as "effectSlot",kind,state,guild_id as "guildId",capability_channel_id as "capabilityChannelId",target_channel_id as "targetChannelId",thread_id as "threadId",target_message_id as "targetMessageId",external_resource_id as "externalResourceId",executor_id as "executorId",attempts,error,created_at as "createdAt",updated_at as "updatedAt",payload,capability_decision as "capabilityDecision" from effects where id=${id}`;
    if (!rows[0]) throw new Error("Effect not found");
    const row = rows[0];
    if (row.kind !== "discord.reply") throw new Error(`Unsupported effect kind: ${row.kind}`);
    const payload = DiscordReplyPayloadSchema.parse(row.payload);
    if (
      typeof row.capabilityDecision !== "object" ||
      row.capabilityDecision === null ||
      Array.isArray(row.capabilityDecision)
    )
      throw new Error("Invalid capability decision");
    return {
      ...row,
      kind: "discord.reply",
      content: payload.content,
      allowedMentions: payload.allowedMentions,
      capabilityDecision: row.capabilityDecision as Record<string, unknown>,
    };
  }
  public async reconcileUnknown(
    id: string,
    state: "succeeded" | "failed",
    externalResourceId: string | null,
    actorName: string,
    reason: string,
    now: Date,
  ): Promise<void> {
    actor(actorName, "Actor");
    actor(reason, "Reason");
    date(now, "now");
    if (state === "succeeded") actor(externalResourceId ?? "", "External resource ID");
    if (state === "failed" && externalResourceId !== null)
      throw new Error("Failed effect cannot have external resource ID");
    await this.transition(
      id,
      "unknown",
      state,
      now,
      state === "failed" ? reason : null,
      externalResourceId,
      "effect.reconciled",
      { actor: actorName, reason, externalResourceId },
    );
  }
}
