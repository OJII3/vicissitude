import { describe, expect, test } from "bun:test";

import { Collection } from "discord.js";
import type { Attachment as DiscordAttachment } from "discord.js";

import { filterImageUrls, mapAttachments } from "./attachment-mapper.ts";

function makeAttachment(
	overrides: Partial<DiscordAttachment> & { id?: string } = {},
): DiscordAttachment {
	return {
		id: overrides.id ?? "att-1",
		url: "https://cdn.discord.com/test.png",
		contentType: "image/png",
		name: "test.png",
		...overrides,
	} as unknown as DiscordAttachment;
}

function collectionOf(
	...items: Array<Partial<DiscordAttachment> & { id?: string }>
): Collection<string, DiscordAttachment> {
	const col = new Collection<string, DiscordAttachment>();
	for (const item of items) {
		const att = makeAttachment(item);
		col.set(att.id, att);
	}
	return col;
}

describe("mapAttachments", () => {
	test("許可 MIME (png, jpeg, gif, webp) → 変換して返す", () => {
		const col = collectionOf(
			{ id: "1", url: "https://a/1.png", contentType: "image/png", name: "1.png" },
			{ id: "2", url: "https://a/2.jpg", contentType: "image/jpeg", name: "2.jpg" },
			{ id: "3", url: "https://a/3.gif", contentType: "image/gif", name: "3.gif" },
			{ id: "4", url: "https://a/4.webp", contentType: "image/webp", name: "4.webp" },
		);

		const result = mapAttachments(col);

		expect(result).toHaveLength(4);
		expect(result[0]).toEqual({
			url: "https://a/1.png",
			contentType: "image/png",
			filename: "1.png",
		});
	});

	test("contentType null → フィルタ除外", () => {
		const col = collectionOf({ id: "1", contentType: null as unknown as string });

		expect(mapAttachments(col)).toHaveLength(0);
	});

	test("非画像 MIME → フィルタ除外", () => {
		const col = collectionOf(
			{ id: "1", contentType: "application/pdf", name: "doc.pdf" },
			{ id: "2", contentType: "text/plain", name: "readme.txt" },
		);

		expect(mapAttachments(col)).toHaveLength(0);
	});

	test("空コレクション → 空配列", () => {
		const col = new Collection<string, DiscordAttachment>();
		expect(mapAttachments(col)).toEqual([]);
	});
});

describe("filterImageUrls", () => {
	test("画像 URL のみ返す", () => {
		const col = collectionOf(
			{ id: "1", url: "https://a/img.png", contentType: "image/png" },
			{ id: "2", url: "https://a/doc.pdf", contentType: "application/pdf" },
			{ id: "3", url: "https://a/img2.jpeg", contentType: "image/jpeg" },
		);

		const urls = filterImageUrls(col);
		expect(urls).toEqual(["https://a/img.png", "https://a/img2.jpeg"]);
	});

	test("非画像はフィルタ除外", () => {
		const col = collectionOf({ id: "1", contentType: "video/mp4", url: "https://a/vid.mp4" });

		expect(filterImageUrls(col)).toEqual([]);
	});
});
