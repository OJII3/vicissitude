import type { Sql, TransactionSql } from "postgres";
import type { CanonicalMessageEvent } from "../../modules/events/canonical-event.js";
import type {
  ConversationJobDirective,
  IngestionStore,
  QueuedJobExtension,
} from "../../modules/events/ingest-message.js";

export class PostgresIngestionStore implements IngestionStore {
  public constructor(private readonly sql: Sql) {}

  public async saveEventAndSyncJob(
    event: CanonicalMessageEvent,
    directive: ConversationJobDirective,
  ): Promise<{ eventId: string; duplicate: boolean; jobQueued: boolean; jobExtended: boolean }> {
    return this.sql.begin(async (transaction) => {
      const inserted = await transaction<{ id: string }[]>`
        insert into events (id, schema_version, source, external_event_id, external_version, kind, visibility, guild_id, channel_id, thread_id, actor_id, actor_kind, occurred_at, received_at, content, expires_at)
        values (${event.id}, ${event.schemaVersion}, ${event.source}, ${event.externalEventId}, ${event.externalVersion}, ${event.kind}, ${event.visibility}, ${event.guildId}, ${event.channelId}, ${event.threadId}, ${event.actorId}, ${event.actorKind}, ${event.occurredAt}, ${event.receivedAt}, ${transaction.json(JSON.parse(JSON.stringify(event.content)))}, ${event.expiresAt})
        on conflict (source, external_event_id, external_version) do nothing returning id
      `;
      if (!inserted[0]) {
        const existing = await transaction<
          { id: string }[]
        >`select id from events where source = ${event.source} and external_event_id = ${event.externalEventId} and external_version = ${event.externalVersion}`;
        if (!existing[0]) throw new Error("Duplicate event conflict could not find existing event");
        return { eventId: existing[0].id, duplicate: true, jobQueued: false, jobExtended: false };
      }
      let jobQueued = false;
      let jobExtended = false;
      if (directive.kind === "enqueue") {
        const job = directive.job;
        const rows = await transaction<{ inserted: boolean }[]>`
          insert into jobs (id, kind, guild_id, channel_id, thread_id, trigger_event_id, priority, state, available_at, first_triggered_at, attempts, max_attempts, created_at, updated_at)
          values (${job.id}, ${job.kind}, ${job.guildId}, ${job.channelId}, ${job.threadId}, ${job.triggerEventId}, ${job.priority}, 'queued', ${job.availableAt}, ${job.firstTriggeredAt}, 0, ${job.maxAttempts}, ${event.receivedAt}, ${event.receivedAt})
          on conflict (kind, guild_id, channel_id, (coalesce(thread_id, ''))) where state = 'queued'
          do update set available_at = least(${job.availableAt}, jobs.first_triggered_at + ${job.maxWaitMs} * interval '1 millisecond'), updated_at = ${event.receivedAt}
          returning (xmax = 0) as inserted
        `;
        jobQueued = rows[0]?.inserted === true;
        jobExtended = rows[0] !== undefined && !rows[0].inserted;
      } else if (directive.kind === "extend") {
        jobExtended = await extendQueuedJobIn(transaction, directive.extension);
      }
      return { eventId: event.id, duplicate: false, jobQueued, jobExtended };
    });
  }

  /** typing 延長（設計 §3.2）。queued job がなければ何もしない。 */
  public async extendQueuedJob(extension: QueuedJobExtension): Promise<boolean> {
    return extendQueuedJobIn(this.sql, extension);
  }
}

async function extendQueuedJobIn(sql: Sql | TransactionSql, extension: QueuedJobExtension): Promise<boolean> {
  const rows = await sql`
    update jobs
    set available_at = least(${extension.availableAt}, first_triggered_at + ${extension.maxWaitMs} * interval '1 millisecond'), updated_at = ${extension.now}
    where kind = 'conversation_evaluate' and state = 'queued'
      and guild_id = ${extension.guildId} and channel_id = ${extension.channelId}
      and coalesce(thread_id, '') = ${extension.threadId ?? ""}
    returning id
  `;
  return rows.length > 0;
}
