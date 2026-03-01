import { describe, expect, it } from "bun:test";

import type { EmojiInfo } from "../entities/emoji-info.ts";
import type { EmojiUsageCount } from "../entities/emoji-usage.ts";
import { filterTopEmojis } from "./emoji-ranking.ts";

const allEmojis: EmojiInfo[] = [
	{ name: "pepe_sad", identifier: "111", animated: false },
	{ name: "pepe_happy", identifier: "222", animated: true },
	{ name: "thumbsup", identifier: "333", animated: false },
	{ name: "fire", identifier: "444", animated: false },
];

describe("filterTopEmojis", () => {
	it("topUsage に含まれる絵文字のみ返す", () => {
		const topUsage: EmojiUsageCount[] = [
			{ emojiName: "pepe_sad", count: 42 },
			{ emojiName: "fire", count: 10 },
		];

		const result = filterTopEmojis(allEmojis, topUsage);

		expect(result).toEqual([
			{ name: "pepe_sad", identifier: "111", animated: false },
			{ name: "fire", identifier: "444", animated: false },
		]);
	});

	it("topUsage の順序（人気順）を維持する", () => {
		const topUsage: EmojiUsageCount[] = [
			{ emojiName: "fire", count: 100 },
			{ emojiName: "pepe_happy", count: 50 },
			{ emojiName: "pepe_sad", count: 10 },
		];

		const result = filterTopEmojis(allEmojis, topUsage);

		expect(result.map((e) => e.name)).toEqual(["fire", "pepe_happy", "pepe_sad"]);
	});

	it("削除済み絵文字（allEmojis にない）は除外される", () => {
		const topUsage: EmojiUsageCount[] = [
			{ emojiName: "deleted_emoji", count: 99 },
			{ emojiName: "pepe_sad", count: 42 },
		];

		const result = filterTopEmojis(allEmojis, topUsage);

		expect(result).toEqual([{ name: "pepe_sad", identifier: "111", animated: false }]);
	});

	it("allEmojis が空なら空配列を返す", () => {
		const topUsage: EmojiUsageCount[] = [{ emojiName: "pepe_sad", count: 42 }];

		const result = filterTopEmojis([], topUsage);

		expect(result).toEqual([]);
	});

	it("topUsage が空なら空配列を返す", () => {
		const result = filterTopEmojis(allEmojis, []);

		expect(result).toEqual([]);
	});

	it("両方空なら空配列を返す", () => {
		const result = filterTopEmojis([], []);

		expect(result).toEqual([]);
	});
});
