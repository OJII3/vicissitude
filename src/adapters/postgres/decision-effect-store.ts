import type { Sql } from "postgres";
import { z } from "zod";
import { DiscordReplyPayloadSchema } from "../../modules/effects/effect.js";
import type {
  ConversationBatchView,
  ConversationMessageView,
  ConversationStore,
  ModelCallRecord,
} from "../../modules/conversations/evaluate-conversation.js";
import { newId } from "../../shared/ids.js";

const EventContent = z.strictObject({
  text: z.string(),
  mentionedBot: z.boolean(),
  mentionIds: z.array(z.string()),
  replyToMessageId: z.string().nullable(),
  attachments: z.array(z.unknown()),
});
const allowedErrors = new Set([
  "model_runtime_failed",
  "model_aborted",
  "response_empty",
  "response_too_long",
  "conversation_processing_failed",
]);
const bounded = (value: string) => (allowedErrors.has(value) ? value : "conversation_processing_failed").slice(0, 2000);

interface EventRow {
  id: string;
  external_event_id: string;
  actor_id: string;
  occurred_at: Date;
  content: unknown;
}
function toMessageView(row: EventRow): ConversationMessageView {
  const content = EventContent.parse(row.content);
  return {
    eventId: row.id,
    messageId: row.external_event_id,
    actorId: row.actor_id,
    occurredAt: row.occurred_at,
    text: content.text,
    mentionedBot: content.mentionedBot,
    replyToMessageId: content.replyToMessageId,
  };
}

export class PostgresDecisionEffectStore implements ConversationStore {
  constructor(private readonly sql: Sql) {}

  async loadBatch(
    job: { guildId: string; channelId: string; threadId: string | null; triggerEventId: string | null },
    claimedAt: Date,
  ): Promise<ConversationBatchView> {
    if (!job.triggerEventId) throw new Error("conversation_evaluate job has no trigger event");
    const triggerRows = await this.sql<
      Array<
        EventRow & {
          kind: string;
          visibility: string;
          guild_id: string;
          channel_id: string;
          thread_id: string | null;
          actor_kind: string;
        }
      >
    >`select id, kind, visibility, external_event_id, guild_id, channel_id, thread_id, actor_id, actor_kind, occurred_at, content from events where id = ${job.triggerEventId}`;
    const trigger = triggerRows[0];
    if (
      !trigger ||
      trigger.kind !== "message.created" ||
      !["observed", "mention_only"].includes(trigger.visibility) ||
      trigger.actor_kind !== "human"
    )
      throw new Error(`Invalid trigger event: ${job.triggerEventId}`);
    const triggerView = toMessageView(trigger);
    if (!triggerView.mentionedBot) throw new Error(`Trigger event is not a mention: ${job.triggerEventId}`);

    const cursors = await this.sql<{ last_event_id: string; last_occurred_at: Date }[]>`
      select last_event_id, last_occurred_at from conversation_cursors
      where guild_id = ${job.guildId} and channel_id = ${job.channelId} and thread_id = ${job.threadId ?? ""}
    `;
    const cursor = cursors[0];
    const rows = await this.sql<EventRow[]>`
      select id, external_event_id, actor_id, occurred_at, content from events
      where guild_id = ${job.guildId} and channel_id = ${job.channelId}
        and coalesce(thread_id, '') = ${job.threadId ?? ""}
        and kind = 'message.created'
        and occurred_at <= ${claimedAt}
        ${
          cursor
            ? this
                .sql`and ((occurred_at, id) > (${cursor.last_occurred_at}, ${cursor.last_event_id}::uuid) or id = ${job.triggerEventId}::uuid)`
            : this.sql``
        }
      order by occurred_at, id
    `;
    return {
      guildId: trigger.guild_id,
      capabilityChannelId: trigger.channel_id,
      targetChannelId: trigger.thread_id ?? trigger.channel_id,
      threadId: trigger.thread_id,
      trigger: triggerView,
      messages: rows.map(toMessageView),
    };
  }

  async startOrLoadRun(input: {
    jobId: string;
    triggerEventId: string;
    leaseToken: string;
    characterId: string;
    characterVersion: number;
    routeVersion: string;
    now: Date;
  }): Promise<{ runId: string; state: "running" | "succeeded" | "failed" }> {
    return this.sql.begin(async (tx) => {
      const jobs = await tx<
        Array<{ trigger_event_id: string | null }>
      >`select trigger_event_id from jobs where id = ${input.jobId} and state = 'running' and lease_token = ${input.leaseToken} and leased_until > ${input.now} for update`;
      if (!jobs[0] || jobs[0].trigger_event_id !== input.triggerEventId) throw new Error("Lease lost");
      await tx`insert into decision_runs (id, job_id, event_id, character_id, character_version, state, model_route_version, started_at) values (${newId()}, ${input.jobId}, ${input.triggerEventId}, ${input.characterId}, ${input.characterVersion}, 'running', ${input.routeVersion}, ${input.now}) on conflict (job_id) do nothing`;
      const rows = await tx<
        Array<{
          id: string;
          state: "running" | "succeeded" | "failed";
          event_id: string;
          character_id: string;
          character_version: number;
          model_route_version: string;
        }>
      >`select id, state, event_id, character_id, character_version, model_route_version from decision_runs where job_id = ${input.jobId}`;
      const row = rows[0];
      if (!row) throw new Error("Decision run disappeared");
      if (
        row.event_id !== input.triggerEventId ||
        row.character_id !== input.characterId ||
        row.character_version !== input.characterVersion ||
        row.model_route_version !== input.routeVersion
      )
        throw new Error("Decision run metadata mismatch");
      return { runId: row.id, state: row.state };
    });
  }

  async recordRunInputEvents(runId: string, eventIds: string[]): Promise<void> {
    if (eventIds.length === 0) return;
    await this.sql`
      insert into run_input_events (run_id, event_id)
      select ${runId}, unnest(${this.sql.array(eventIds)}::uuid[])
      on conflict do nothing
    `;
  }

  async recordModelCall(record: ModelCallRecord): Promise<void> {
    const u = record.usage;
    await this
      .sql`insert into model_calls (id, run_id, purpose, provider, model, route_version, attempt, state, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, estimated_cost_usd, latency_ms, fallback_from, structured_output_failure, error, created_at) values (${newId()}, ${record.runId}, ${record.purpose}, ${record.provider}, ${record.model}, ${record.routeVersion}, ${record.attempt}, ${record.state}, ${u?.input ?? 0}, ${u?.output ?? 0}, ${u?.cacheRead ?? 0}, ${u?.cacheWrite ?? 0}, ${u?.cost?.total ?? 0}, ${record.latencyMs}, ${record.fallbackFrom}, false, ${record.error ? bounded(record.error) : null}, ${record.createdAt})`;
  }

  async completeWithReply(input: {
    runId: string;
    jobId: string;
    leaseToken: string;
    triggerEventId: string;
    cursor: { lastEventId: string; lastOccurredAt: Date };
    content: string;
    fallback: boolean;
    now: Date;
  }): Promise<void> {
    const payload = DiscordReplyPayloadSchema.parse({
      content: input.content,
      allowedMentions: { parse: [], repliedUser: false },
    });
    await this.sql.begin(async (tx) => {
      const canonicalJob = await tx<
        Array<{ trigger_event_id: string | null; guild_id: string; channel_id: string; thread_id: string | null }>
      >`select trigger_event_id, guild_id, channel_id, thread_id from jobs where id = ${input.jobId} for update`;
      if (!canonicalJob[0] || canonicalJob[0].trigger_event_id !== input.triggerEventId)
        throw new Error("Invalid job event");
      const runs = await tx<
        Array<{ state: string; job_id: string; event_id: string }>
      >`select state, job_id, event_id from decision_runs where id = ${input.runId} for update`;
      const run = runs[0];
      if (!run || run.job_id !== input.jobId || run.event_id !== input.triggerEventId || run.state === "failed")
        throw new Error("Invalid decision run");
      if (run.state === "succeeded") {
        const existing =
          await tx`select 1 from effects where run_id = ${input.runId} and effect_slot = 'primary_reply'`;
        if (existing.length) return;
        throw new Error("Succeeded run has no primary effect");
      }
      const jobUpdate =
        await tx`update jobs set state = 'succeeded', leased_until = null, lease_owner = null, lease_token = null, updated_at = ${input.now} where id = ${input.jobId} and trigger_event_id = ${input.triggerEventId} and state = 'running' and lease_token = ${input.leaseToken} and leased_until > ${input.now} returning id`;
      if (!jobUpdate.length) throw new Error("Lease lost");
      await tx`update decision_runs set state = 'succeeded', action_kind = 'reply', reason_codes = ${tx.array(["explicit_mention", input.fallback ? "model_fallback" : "model_response"])}, finished_at = ${input.now} where id = ${input.runId}`;
      const eventRows = await tx<
        Array<{
          guild_id: string;
          channel_id: string;
          thread_id: string | null;
          external_event_id: string;
          actor_kind: string;
          kind: string;
          visibility: string;
          content: unknown;
        }>
      >`select guild_id, channel_id, thread_id, external_event_id, actor_kind, kind, visibility, content from events where id = ${input.triggerEventId}`;
      const event = eventRows[0];
      const eventContent = event ? EventContent.safeParse(event.content) : null;
      if (
        !event ||
        event.kind !== "message.created" ||
        !["observed", "mention_only"].includes(event.visibility) ||
        event.actor_kind !== "human" ||
        !eventContent?.success ||
        !eventContent.data.mentionedBot
      )
        throw new Error("Invalid trigger event");
      const effects = await tx<
        Array<{ id: string }>
      >`insert into effects (id, run_id, effect_slot, kind, state, guild_id, capability_channel_id, target_channel_id, thread_id, target_message_id, payload, capability_decision, created_at, updated_at) values (${newId()}, ${input.runId}, 'primary_reply', 'discord.reply', 'planned', ${event.guild_id}, ${event.channel_id}, ${event.thread_id ?? event.channel_id}, ${event.thread_id}, ${event.external_event_id}, ${tx.json(payload)}, ${tx.json({ action: "respond_to_mention", allowed: true })}, ${input.now}, ${input.now}) returning id`;
      await tx`
        insert into conversation_cursors (guild_id, channel_id, thread_id, last_event_id, last_occurred_at, updated_at)
        values (${canonicalJob[0].guild_id}, ${canonicalJob[0].channel_id}, ${canonicalJob[0].thread_id ?? ""}, ${input.cursor.lastEventId}, ${input.cursor.lastOccurredAt}, ${input.now})
        on conflict (guild_id, channel_id, thread_id) do update
        set last_event_id = excluded.last_event_id, last_occurred_at = excluded.last_occurred_at, updated_at = excluded.updated_at
        where (conversation_cursors.last_occurred_at, conversation_cursors.last_event_id) < (excluded.last_occurred_at, excluded.last_event_id)
      `;
      await tx`insert into audit_entries (id, category, event_id, job_id, run_id, effect_id, summary, created_at) values (${newId()}, 'decision.completed', ${input.triggerEventId}, ${input.jobId}, ${input.runId}, ${effects[0]!.id}, ${tx.json({ action: "reply", fallback: input.fallback })}, ${input.now})`;
    });
  }

  async failRunAndJob(jobId: string, leaseToken: string, error: string, now: Date): Promise<void> {
    await this.sql.begin(async (tx) => {
      const lockedJobs = await tx<
        Array<{ id: string; trigger_event_id: string | null }>
      >`select id, trigger_event_id from jobs where id = ${jobId} for update`;
      if (!lockedJobs[0]) throw new Error("Job not found");
      const runs = await tx<
        Array<{ id: string; state: string }>
      >`select id, state from decision_runs where job_id = ${jobId} for update`;
      if (runs[0]?.state === "succeeded") throw new Error("Succeeded decision run cannot fail");
      const jobs =
        await tx`update jobs set state = 'failed', last_error = ${bounded(error)}, leased_until = null, lease_owner = null, lease_token = null, updated_at = ${now} where id = ${jobId} and state = 'running' and lease_token = ${leaseToken} and leased_until > ${now} returning id`;
      if (!jobs.length) throw new Error("Lease lost");
      const runId = runs[0]?.id ?? null;
      if (runId)
        await tx`update decision_runs set state = 'failed', error = ${bounded(error)}, finished_at = ${now} where id = ${runId} and state = 'running'`;
      await tx`insert into audit_entries (id, category, event_id, job_id, run_id, summary, created_at) values (${newId()}, 'decision.failed', null, ${jobId}, ${runId}, ${tx.json({ error: bounded(error) })}, ${now})`;
    });
  }
}
