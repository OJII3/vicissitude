import type { Client, TextBasedChannel } from "discord.js";

import type {
	ConversationContext,
	ConversationMessage,
} from "../../domain/entities/conversation-context.ts";
import type { ConversationHistory } from "../../domain/ports/conversation-history.port.ts";

export class DiscordConversationHistory implements ConversationHistory {
	constructor(private readonly getClient: () => Client | null) {}

	async getRecent(channelId: string, limit: number): Promise<ConversationContext> {
		const client = this.getClient();
		if (!client) return { channelId, messages: [] };

		const channel = await client.channels.fetch(channelId);
		if (!channel || !("messages" in channel)) return { channelId, messages: [] };

		const textChannel = channel as TextBasedChannel;
		const fetched = await textChannel.messages.fetch({ limit });

		const messages: ConversationMessage[] = [];
		// discord.js returns newest first, reverse to chronological order
		const sorted = [...fetched.values()].toReversed();
		for (const msg of sorted) {
			messages.push({
				authorName: msg.author.displayName ?? msg.author.username,
				content: msg.content,
			});
		}

		return { channelId, messages };
	}
}
