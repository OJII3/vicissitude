import type { Clock } from "../../shared/clock.js";
import { newId } from "../../shared/ids.js";
import type { ChannelCapabilities } from "../channels/channel-capability.js";
import type { BatchConfig } from "../conversations/batch-schedule.js";
import type { SystemMode } from "../system/system-control.js";
import type { CanonicalMessageEvent, DiscordMessageInput } from "./canonical-event.js";

const RAW_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export interface ConversationEvaluateJobInput {
  id: string;
  kind: "conversation_evaluate";
  guildId: string;
  channelId: string;
  threadId: string | null;
  triggerEventId: string;
  priority: 100;
  firstTriggeredAt: Date;
  /** now + batchWindow。既存 queued job と競合したら DB 側で maxWait 上限つき延長になる。 */
  availableAt: Date;
  maxWaitMs: number;
  maxAttempts: 3;
}

export interface QueuedJobExtension {
  guildId: string;
  channelId: string;
  threadId: string | null;
  /** now + batchWindow。 */
  availableAt: Date;
  maxWaitMs: number;
  now: Date;
}

export type ConversationJobDirective =
  | { kind: "none" }
  | { kind: "enqueue"; job: ConversationEvaluateJobInput }
  | { kind: "extend"; extension: QueuedJobExtension };

export interface IngestionStore {
  saveEventAndSyncJob(
    event: CanonicalMessageEvent,
    directive: ConversationJobDirective,
  ): Promise<{ eventId: string; duplicate: boolean; jobQueued: boolean; jobExtended: boolean }>;
}

export type IngestMessageResult =
  | { kind: "ignored"; reason: "channel_not_allowed" }
  | { kind: "accepted"; eventId: string; duplicate: boolean; jobQueued: boolean; jobExtended: boolean };

export async function ingestDiscordMessage(
  input: DiscordMessageInput,
  capability: ChannelCapabilities,
  systemMode: SystemMode,
  batch: BatchConfig,
  store: IngestionStore,
  clock: Clock,
): Promise<IngestMessageResult> {
  if (capability.guildId !== input.guildId || capability.channelId !== input.channelId) {
    return { kind: "ignored", reason: "channel_not_allowed" };
  }
  const mentionAllowed = input.mentionedBot && input.actorKind === "human" && capability.respondToMentions;
  if (!capability.observeEvents && !mentionAllowed) return { kind: "ignored", reason: "channel_not_allowed" };

  const now = clock.now();
  const event: CanonicalMessageEvent = {
    id: newId(),
    schemaVersion: 1,
    source: "discord",
    externalEventId: input.externalEventId,
    externalVersion: input.externalVersion,
    kind: "message.created",
    visibility: capability.observeEvents ? "observed" : "mention_only",
    guildId: input.guildId,
    channelId: input.channelId,
    threadId: input.threadId,
    actorId: input.actorId,
    actorKind: input.actorKind,
    occurredAt: new Date(input.occurredAt),
    receivedAt: new Date(now),
    content: {
      text: input.content,
      mentionedBot: input.mentionedBot,
      mentionIds: [...input.mentionIds],
      replyToMessageId: input.replyToMessageId,
      attachments: input.attachments.map((attachment) => ({ ...attachment })),
    },
    expiresAt: new Date(now.getTime() + RAW_EVENT_RETENTION_MS),
  };
  const availableAt = new Date(now.getTime() + batch.batchWindowMs);
  const directive: ConversationJobDirective =
    systemMode === "stopped"
      ? { kind: "none" }
      : mentionAllowed
        ? {
            kind: "enqueue",
            job: {
              id: newId(),
              kind: "conversation_evaluate",
              guildId: input.guildId,
              channelId: input.channelId,
              threadId: input.threadId,
              triggerEventId: event.id,
              priority: 100,
              firstTriggeredAt: new Date(now),
              availableAt,
              maxWaitMs: batch.maxWaitMs,
              maxAttempts: 3,
            },
          }
        : {
            kind: "extend",
            extension: {
              guildId: input.guildId,
              channelId: input.channelId,
              threadId: input.threadId,
              availableAt,
              maxWaitMs: batch.maxWaitMs,
              now: new Date(now),
            },
          };
  const saved = await store.saveEventAndSyncJob(event, directive);
  return {
    kind: "accepted",
    eventId: saved.eventId,
    duplicate: saved.duplicate,
    jobQueued: saved.jobQueued,
    jobExtended: saved.jobExtended,
  };
}
