import type { Client } from "discord.js";

import type { EmojiInfo } from "../../domain/entities/emoji-info.ts";
import type { EmojiProvider } from "../../domain/ports/emoji-provider.port.ts";

export class DiscordEmojiProvider implements EmojiProvider {
	constructor(private readonly getClient: () => Client | null) {}

	async getGuildEmojis(guildId: string): Promise<EmojiInfo[]> {
		const client = this.getClient();
		if (!client) return [];

		const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId));
		if (!guild) return [];

		const emojis = guild.emojis.cache;
		return emojis.map((e) => ({
			name: e.name ?? "",
			identifier: e.id,
			animated: e.animated ?? false,
		}));
	}
}
