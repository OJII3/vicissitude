import type { Client, TextBasedChannel } from "discord.js";

import type {
	ConversationContext,
	ConversationMessage,
} from "../../domain/entities/conversation-context.ts";
import type { ConversationHistory } from "../../domain/ports/conversation-history.port.ts";
import { mapAttachments } from "./discord-attachment-mapper.ts";

export class DiscordConversationHistory implements ConversationHistory {
	constructor(private readonly getClient: () => Client | null) {}

	async getRecent(
		channelId: string,
		limit: number,
		excludeMessageId?: string,
	): Promise<ConversationContext> {
		const client = this.getClient();
		if (!client) return { channelId, messages: [] };

		// キャッシュ優先、ミス時のみ REST API
		const channel =
			client.channels.cache.get(channelId) ?? (await client.channels.fetch(channelId));
		if (!channel || !("messages" in channel)) return { channelId, messages: [] };

		const textChannel = channel as TextBasedChannel;
		const clampedLimit = Math.min(limit, 25);
		const fetched = await textChannel.messages.fetch({ limit: clampedLimit });

		const messages: ConversationMessage[] = [];
		const sorted = [...fetched.values()].toReversed();
		for (const msg of sorted) {
			if (excludeMessageId && msg.id === excludeMessageId) continue;
			const attachments = mapAttachments(msg.attachments);
			messages.push({
				authorName: msg.author.displayName ?? msg.author.username,
				content: msg.content,
				attachments,
				timestamp: msg.createdAt,
			});
		}

		return { channelId, messages };
	}
}
