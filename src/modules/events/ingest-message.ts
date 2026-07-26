import type { Clock } from "../../shared/clock.js";
import { newId } from "../../shared/ids.js";
import type { ChannelCapabilities } from "../channels/channel-capability.js";
import type { SystemMode } from "../system/system-control.js";
import type { CanonicalMessageEvent, DiscordMessageInput } from "./canonical-event.js";

const RAW_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export interface MentionResponseJobInput {
  id: string;
  kind: "mention_response";
  eventId: string;
  priority: 100;
  availableAt: Date;
  maxAttempts: 3;
}

export interface IngestionStore {
  saveEventAndMaybeEnqueue(
    event: CanonicalMessageEvent,
    job: MentionResponseJobInput | null,
  ): Promise<{ eventId: string; duplicate: boolean }>;
}

export type IngestMessageResult =
  | { kind: "ignored"; reason: "channel_not_allowed" }
  | { kind: "accepted"; eventId: string; duplicate: boolean; jobQueued: boolean };

export async function ingestDiscordMessage(
  input: DiscordMessageInput,
  capability: ChannelCapabilities,
  systemMode: SystemMode,
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
  const shouldQueue = mentionAllowed && systemMode !== "stopped";
  const job: MentionResponseJobInput | null = shouldQueue
    ? {
        id: newId(),
        kind: "mention_response",
        eventId: event.id,
        priority: 100,
        availableAt: new Date(now),
        maxAttempts: 3,
      }
    : null;
  const saved = await store.saveEventAndMaybeEnqueue(event, job);
  return {
    kind: "accepted",
    eventId: saved.eventId,
    duplicate: saved.duplicate,
    jobQueued: shouldQueue && !saved.duplicate,
  };
}
