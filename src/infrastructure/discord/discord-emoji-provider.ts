import type { Client } from "discord.js";

import type { EmojiInfo } from "../../domain/entities/emoji-info.ts";
import type { EmojiProvider } from "../../domain/ports/emoji-provider.port.ts";

const EMPTY: EmojiInfo[] = [];

export class DiscordEmojiProvider implements EmojiProvider {
	constructor(private readonly getClient: () => Client | null) {}

	getGuildEmojis(guildId: string): Promise<EmojiInfo[]> {
		const client = this.getClient();
		if (!client) return Promise.resolve(EMPTY);

		// cache のみ参照（fetch は OAuth2Guild を返し emojis がない）
		const guild = client.guilds.cache.get(guildId);
		if (!guild) return Promise.resolve(EMPTY);

		const emojis = guild.emojis.cache;
		return Promise.resolve(
			emojis.map((e) => ({
				name: e.name ?? "",
				identifier: e.id,
				animated: e.animated ?? false,
			})),
		);
	}
}
