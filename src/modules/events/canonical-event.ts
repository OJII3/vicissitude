export interface AttachmentMetadata {
  id: string;
  name: string;
  contentType: string | null;
  url: string;
  size: number;
}

export interface DiscordMessageInput {
  externalEventId: string;
  externalVersion: string;
  guildId: string;
  channelId: string;
  threadId: string | null;
  actorId: string;
  actorKind: "human" | "bot";
  occurredAt: Date;
  content: string;
  mentionedBot: boolean;
  mentionIds: string[];
  replyToMessageId: string | null;
  attachments: AttachmentMetadata[];
}

export interface CanonicalMessageEvent {
  id: string;
  schemaVersion: 1;
  source: "discord";
  externalEventId: string;
  externalVersion: string;
  kind: "message.created";
  visibility: "observed" | "mention_only";
  guildId: string;
  channelId: string;
  threadId: string | null;
  actorId: string;
  actorKind: "human" | "bot";
  occurredAt: Date;
  receivedAt: Date;
  content: {
    text: string;
    mentionedBot: boolean;
    mentionIds: string[];
    replyToMessageId: string | null;
    attachments: AttachmentMetadata[];
  };
  expiresAt: Date;
}
