import type { EmojiInfo } from "../entities/emoji-info.ts";
import type { EmojiUsageCount } from "../entities/emoji-usage.ts";

/**
 * 使用頻度トップの絵文字で allEmojis をフィルタリングする。
 * topUsage の順序（人気順）を維持し、削除済み絵文字は自然に除外される。
 */
export function filterTopEmojis(allEmojis: EmojiInfo[], topUsage: EmojiUsageCount[]): EmojiInfo[] {
	const emojiByName = new Map(allEmojis.map((e) => [e.name, e]));

	const result: EmojiInfo[] = [];
	for (const usage of topUsage) {
		const emoji = emojiByName.get(usage.emojiName);
		if (emoji) {
			result.push(emoji);
		}
	}
	return result;
}
