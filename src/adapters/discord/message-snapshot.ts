import type { DiscordMessageInput } from "../../modules/events/canonical-event.js";

export interface DiscordMessageSnapshot {
  id: string;
  guildId: string | null;
  channelId: string;
  parentChannelId: string | null;
  isThread: boolean;
  authorId: string;
  authorIsBot: boolean;
  createdTimestamp: number;
  content: string;
  mentionedUserIds: string[];
  replyToMessageId: string | null;
  attachments: Array<{ id: string; name: string; contentType: string | null; url: string; size: number }>;
}

const required = (value: string, name: string): void => {
  if (!value.trim()) throw new Error(`${name} is required`);
};

export function toDiscordMessageInput(snapshot: DiscordMessageSnapshot, botUserId: string): DiscordMessageInput {
  if (!snapshot.guildId) throw new Error("DM events are outside MVP scope");
  required(snapshot.id, "message ID");
  required(snapshot.channelId, "channel ID");
  required(snapshot.authorId, "author ID");
  required(botUserId, "bot ID");
  if (snapshot.isThread && !snapshot.parentChannelId) throw new Error("Thread message has no parent channel");
  const occurredAt = new Date(snapshot.createdTimestamp);
  if (!Number.isFinite(occurredAt.getTime())) throw new Error("occurredAt must be a valid timestamp");
  return {
    externalEventId: snapshot.id,
    externalVersion: "0",
    guildId: snapshot.guildId,
    channelId: snapshot.isThread ? snapshot.parentChannelId! : snapshot.channelId,
    threadId: snapshot.isThread ? snapshot.channelId : null,
    actorId: snapshot.authorId,
    actorKind: snapshot.authorIsBot ? "bot" : "human",
    occurredAt,
    content: snapshot.content,
    mentionedBot: snapshot.mentionedUserIds.includes(botUserId),
    mentionIds: [...snapshot.mentionedUserIds],
    replyToMessageId: snapshot.replyToMessageId,
    attachments: snapshot.attachments.map((attachment) => ({ ...attachment })),
  };
}
