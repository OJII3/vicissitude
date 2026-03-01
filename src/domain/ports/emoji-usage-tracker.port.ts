import type { EmojiUsageCount } from "../entities/emoji-usage.ts";

export interface EmojiUsageTracker {
	/** カスタム絵文字の使用をカウント（インメモリ、同期） */
	increment(guildId: string, emojiName: string): void;
	/** 使用頻度トップ N を返す */
	getTopEmojis(guildId: string, limit: number): EmojiUsageCount[];
	/** データがあるか（コールドスタート判定） */
	hasData(guildId: string): boolean;
}
