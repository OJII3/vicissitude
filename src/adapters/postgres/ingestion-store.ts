import type { Sql } from "postgres";
import type { CanonicalMessageEvent } from "../../modules/events/canonical-event.js";
import type { IngestionStore, MentionResponseJobInput } from "../../modules/events/ingest-message.js";

export class PostgresIngestionStore implements IngestionStore {
  public constructor(private readonly sql: Sql) {}

  public async saveEventAndMaybeEnqueue(
    event: CanonicalMessageEvent,
    job: MentionResponseJobInput | null,
  ): Promise<{ eventId: string; duplicate: boolean }> {
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
        return { eventId: existing[0].id, duplicate: true };
      }
      if (job) {
        await transaction`
          insert into jobs (id, kind, event_id, priority, state, available_at, attempts, max_attempts, created_at, updated_at)
          values (${job.id}, ${job.kind}, ${event.id}, ${job.priority}, 'queued', ${job.availableAt}, 0, ${job.maxAttempts}, ${event.receivedAt}, ${event.receivedAt})
        `;
      }
      return { eventId: event.id, duplicate: false };
    });
  }
}
