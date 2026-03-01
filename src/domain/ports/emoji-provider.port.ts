import type { EmojiInfo } from "../entities/emoji-info.ts";

export type { EmojiInfo } from "../entities/emoji-info.ts";

export interface EmojiProvider {
	getGuildEmojis(guildId: string): Promise<EmojiInfo[]>;
}
