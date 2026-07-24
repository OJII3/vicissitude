import type { Client, Message } from "discord.js";
import { DiscordRequestRejectedError, type DiscordMessenger } from "./discord-effect-executor.js";
import type { DiscordMessageSnapshot } from "./message-snapshot.js";

export function snapshotDiscordMessage(message: Message): DiscordMessageSnapshot {
  const isThread = message.channel.isThread();
  return {
    id: message.id,
    guildId: message.guildId,
    channelId: message.channelId,
    parentChannelId: isThread ? message.channel.parentId : null,
    isThread,
    authorId: message.author.id,
    authorIsBot: message.author.bot,
    createdTimestamp: message.createdTimestamp,
    content: message.content,
    mentionedUserIds: [...message.mentions.users.keys()],
    replyToMessageId: message.reference?.messageId ?? null,
    attachments: [...message.attachments.values()].map((attachment) => ({
      id: attachment.id,
      name: attachment.name ?? "",
      contentType: attachment.contentType,
      url: attachment.url,
      size: attachment.size,
    })),
  };
}

export class DiscordClientMessenger implements DiscordMessenger {
  public constructor(
    private readonly client: Client<true>,
    private readonly expectedGuildId: string,
  ) {}

  public async reply(input: Parameters<DiscordMessenger["reply"]>[0]): Promise<{ id: string }> {
    if (input.guildId !== this.expectedGuildId) throw new DiscordRequestRejectedError("Target guild mismatch");
    let channel;
    try {
      channel = await this.client.channels.fetch(input.channelId);
    } catch (error) {
      throw new DiscordRequestRejectedError("Target channel fetch failed", { cause: error });
    }
    if (!channel) throw new DiscordRequestRejectedError("Target channel not found");
    const guildId = "guildId" in channel && typeof channel.guildId === "string" ? channel.guildId : null;
    if (!guildId) throw new DiscordRequestRejectedError("DM channels are not allowed");
    if (guildId !== this.expectedGuildId || guildId !== input.guildId)
      throw new DiscordRequestRejectedError("Target channel guild mismatch");
    if (!channel.isTextBased() || !channel.isSendable())
      throw new DiscordRequestRejectedError("Target channel is not sendable");
    let target;
    try {
      target = await channel.messages.fetch(input.messageId);
    } catch (error) {
      throw new DiscordRequestRejectedError("Target message fetch failed", { cause: error });
    }
    if (!target) throw new DiscordRequestRejectedError("Target message not found");
    const sent = await target.reply({
      content: input.content,
      nonce: input.nonce,
      enforceNonce: input.enforceNonce,
      allowedMentions: input.allowedMentions,
    });
    return { id: sent.id };
  }
}
