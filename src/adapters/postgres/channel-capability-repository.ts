import type { Sql, TransactionSql } from "postgres";
import { newId } from "../../shared/ids.js";
import { denyAllCapabilities, type ChannelCapabilities } from "../../modules/channels/channel-capability.js";

type CapabilityRow = ChannelCapabilities & { updatedAt: Date; updatedBy: string; reason: string };

export type ChannelCapabilitiesPatch = Partial<
  Pick<
    ChannelCapabilities,
    | "observeEvents"
    | "respondToMentions"
    | "spontaneousJoin"
    | "spontaneousTopic"
    | "addReactions"
    | "createThreads"
    | "shareFiles"
    | "shareExternalLinks"
  >
>;

function mapRow(row: Record<string, unknown>): ChannelCapabilities {
  return {
    guildId: row.guild_id as string,
    channelId: row.channel_id as string,
    observeEvents: row.observe_events as boolean,
    respondToMentions: row.respond_to_mentions as boolean,
    spontaneousJoin: row.spontaneous_join as boolean,
    spontaneousTopic: row.spontaneous_topic as boolean,
    addReactions: row.add_reactions as boolean,
    createThreads: row.create_threads as boolean,
    shareFiles: row.share_files as boolean,
    shareExternalLinks: row.share_external_links as boolean,
  };
}

export class PostgresChannelCapabilityRepository {
  public constructor(private readonly sql: Sql) {}

  public async get(guildId: string, channelId: string): Promise<ChannelCapabilities> {
    const rows = await this
      .sql`select * from channel_capabilities where guild_id = ${guildId} and channel_id = ${channelId}`;
    return rows[0] ? mapRow(rows[0]) : denyAllCapabilities(guildId, channelId);
  }

  public async set(value: ChannelCapabilities, actor: string, reason: string, now: Date): Promise<void> {
    validateMetadata(actor, reason, now);
    await this.sql.begin(async (transaction) => {
      await persist(transaction, value.guildId, value.channelId, value, actor.trim(), reason.trim(), now);
    });
  }

  public async patch(
    guildId: string,
    channelId: string,
    patch: ChannelCapabilitiesPatch,
    actor: string,
    reason: string,
    now: Date,
  ): Promise<ChannelCapabilities> {
    validateMetadata(actor, reason, now);
    return this.sql.begin(async (transaction) => {
      await transaction`
        select pg_advisory_xact_lock(hashtextextended(${`${guildId}:${channelId}`}, 84623817))
      `;
      const rows = await transaction<CapabilityRow[]>`
        select * from channel_capabilities where guild_id = ${guildId} and channel_id = ${channelId} for update
      `;
      const before = rows[0]
        ? mapRow(rows[0] as unknown as Record<string, unknown>)
        : denyAllCapabilities(guildId, channelId);
      const next = { ...before, ...patch, guildId, channelId };
      await persist(transaction, guildId, channelId, next, actor.trim(), reason.trim(), now, before);
      return next;
    });
  }
}

function validateMetadata(actor: string, reason: string, now: Date): void {
  if (!actor.trim() || !reason.trim()) throw new Error("actor and reason must be nonblank");
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error("now must be a valid Date");
}

async function persist(
  transaction: TransactionSql,
  guildId: string,
  channelId: string,
  value: ChannelCapabilities,
  actor: string,
  reason: string,
  now: Date,
  knownBefore?: ChannelCapabilities,
): Promise<void> {
  await transaction`
    select pg_advisory_xact_lock(hashtextextended(${`${guildId}:${channelId}`}, 84623817))
  `;
  const beforeRows = knownBefore
    ? []
    : await transaction<CapabilityRow[]>`
        select * from channel_capabilities where guild_id = ${guildId} and channel_id = ${channelId} for update
      `;
  const before =
    knownBefore ??
    (beforeRows[0]
      ? mapRow(beforeRows[0] as unknown as Record<string, unknown>)
      : denyAllCapabilities(guildId, channelId));
  await transaction`
    insert into channel_capabilities (
      guild_id, channel_id, observe_events, respond_to_mentions, spontaneous_join, spontaneous_topic,
      add_reactions, create_threads, share_files, share_external_links, updated_at, updated_by, reason
    ) values (
      ${guildId}, ${channelId}, ${value.observeEvents}, ${value.respondToMentions}, ${value.spontaneousJoin}, ${value.spontaneousTopic},
      ${value.addReactions}, ${value.createThreads}, ${value.shareFiles}, ${value.shareExternalLinks}, ${now}, ${actor}, ${reason}
    ) on conflict (guild_id, channel_id) do update set
      observe_events = excluded.observe_events, respond_to_mentions = excluded.respond_to_mentions,
      spontaneous_join = excluded.spontaneous_join, spontaneous_topic = excluded.spontaneous_topic,
      add_reactions = excluded.add_reactions, create_threads = excluded.create_threads,
      share_files = excluded.share_files, share_external_links = excluded.share_external_links,
      updated_at = excluded.updated_at, updated_by = excluded.updated_by, reason = excluded.reason
  `;
  await transaction`
    insert into audit_entries (id, category, summary, created_at)
    values (${newId()}, 'channel.capability.changed', ${transaction.json(JSON.parse(JSON.stringify({ actor, reason, guildId, channelId, before, after: value })))}, ${now})
  `;
}
