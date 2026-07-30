import type { Sql } from "postgres";
import { newId } from "../../shared/ids.js";
import {
  inheritAllOverride,
  isInheritOnly,
  THREAD_OVERRIDABLE_CAPABILITIES,
  type ThreadCapabilityOverride,
} from "../../modules/channels/thread-capability.js";
import { validateMetadata } from "./capability-metadata.js";

export type ThreadCapabilityPatch = Partial<
  Pick<ThreadCapabilityOverride, "observeEvents" | "respondToMentions" | "addReactions">
>;

// Channel scopes lock on 84623817; thread scopes need a namespace of their own.
const LOCK_NAMESPACE = 84623818;

function mapRow(row: Record<string, unknown>): ThreadCapabilityOverride {
  return {
    guildId: row.guild_id as string,
    channelId: row.channel_id as string,
    threadId: row.thread_id as string,
    observeEvents: row.observe_events as boolean | null,
    respondToMentions: row.respond_to_mentions as boolean | null,
    addReactions: row.add_reactions as boolean | null,
  };
}

function auditValue(override: ThreadCapabilityOverride | null): Record<string, boolean | null> | null {
  if (!override) return null;
  return Object.fromEntries(THREAD_OVERRIDABLE_CAPABILITIES.map((key) => [key, override[key]]));
}

export class PostgresThreadCapabilityRepository {
  public constructor(private readonly sql: Sql) {}

  public async get(guildId: string, channelId: string, threadId: string): Promise<ThreadCapabilityOverride | null> {
    const rows = await this.sql`
      select * from thread_capability_overrides
      where guild_id = ${guildId} and channel_id = ${channelId} and thread_id = ${threadId}
    `;
    return rows[0] ? mapRow(rows[0]) : null;
  }

  public async patch(
    guildId: string,
    channelId: string,
    threadId: string,
    patch: ThreadCapabilityPatch,
    actor: string,
    reason: string,
    now: Date,
  ): Promise<ThreadCapabilityOverride | null> {
    validateMetadata(actor, reason, now);
    const trimmedActor = actor.trim();
    const trimmedReason = reason.trim();
    return this.sql.begin(async (transaction) => {
      await transaction`
        select pg_advisory_xact_lock(hashtextextended(${`${guildId}:${channelId}:${threadId}`}, ${LOCK_NAMESPACE}))
      `;
      const rows = await transaction`
        select * from thread_capability_overrides
        where guild_id = ${guildId} and channel_id = ${channelId} and thread_id = ${threadId}
        for update
      `;
      const before = rows[0] ? mapRow(rows[0]) : null;
      const next: ThreadCapabilityOverride = {
        ...(before ?? inheritAllOverride(guildId, channelId, threadId)),
        ...patch,
      };
      const after = isInheritOnly(next) ? null : next;
      if (after) {
        await transaction`
          insert into thread_capability_overrides (
            guild_id, channel_id, thread_id, observe_events, respond_to_mentions, add_reactions,
            updated_at, updated_by, reason
          ) values (
            ${guildId}, ${channelId}, ${threadId}, ${after.observeEvents}, ${after.respondToMentions},
            ${after.addReactions}, ${now}, ${trimmedActor}, ${trimmedReason}
          ) on conflict (guild_id, channel_id, thread_id) do update set
            observe_events = excluded.observe_events, respond_to_mentions = excluded.respond_to_mentions,
            add_reactions = excluded.add_reactions, updated_at = excluded.updated_at,
            updated_by = excluded.updated_by, reason = excluded.reason
        `;
      } else {
        await transaction`
          delete from thread_capability_overrides
          where guild_id = ${guildId} and channel_id = ${channelId} and thread_id = ${threadId}
        `;
      }
      await transaction`
        insert into audit_entries (id, category, summary, created_at)
        values (
          ${newId()}, 'thread.capability.changed',
          ${transaction.json({
            actor: trimmedActor,
            reason: trimmedReason,
            guildId,
            channelId,
            threadId,
            before: auditValue(before),
            after: auditValue(after),
          })},
          ${now}
        )
      `;
      return after;
    });
  }
}
