/* oxlint-disable max-lines-per-function -- テストファイルはケース数に応じて長くなるため許容 */
import { describe, expect, test } from "bun:test";

import type { IncomingMessage } from "@vicissitude/shared/types";

import { formatDiscordMessage } from "./message-formatter.ts";

function createMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
	return {
		platform: "discord",
		channelId: "ch-1",
		channelName: "general",
		authorId: "user-1",
		authorName: "Alice",
		messageId: "msg-1",
		content: "hello",
		attachments: [],
		timestamp: new Date("2025-01-01T12:00:00+09:00"),
		isBot: false,
		isMentioned: false,
		isThread: false,
		reply: () => Promise.resolve(),
		react: () => Promise.resolve(),
		...overrides,
	};
}

describe("formatDiscordMessage bot-interaction-hint", () => {
	test("bot メッセージの場合にヒントテキストが含まれる", () => {
		const msg = createMessage({ isBot: true });
		const result = formatDiscordMessage(msg);
		expect(result).toContain("[bot-interaction-hint:");
	});

	test("非 bot メッセージの場合にヒントテキストが含まれない", () => {
		const msg = createMessage({ isBot: false });
		const result = formatDiscordMessage(msg);
		expect(result).not.toContain("[bot-interaction-hint:");
	});

	test("system メッセージ（authorId === 'system'）の場合にヒントテキストが含まれない", () => {
		const msg = createMessage({ authorId: "system", isBot: false });
		const result = formatDiscordMessage(msg);
		expect(result).not.toContain("[bot-interaction-hint:");
	});
});

describe("formatDiscordMessage 添付フォーマット", () => {
	test("url が undefined の添付は [添付: filename (contentType) undefined] としてフォーマットされる", () => {
		const msg = createMessage({
			attachments: [
				{ url: undefined as unknown as string, contentType: "image/png", filename: "photo.png" },
			],
		});
		const result = formatDiscordMessage(msg);
		expect(result).toContain("[添付: photo.png (image/png) undefined]");
	});

	test("contentType が undefined の添付は (undefined) としてフォーマットされる", () => {
		const msg = createMessage({
			attachments: [
				{ url: "https://example.com/file.bin", contentType: undefined, filename: "file.bin" },
			],
		});
		const result = formatDiscordMessage(msg);
		expect(result).toContain("[添付: file.bin (undefined) https://example.com/file.bin]");
	});

	test("filename が undefined の添付は undefined としてフォーマットされる", () => {
		const msg = createMessage({
			attachments: [
				{ url: "https://example.com/img.png", contentType: "image/png", filename: undefined },
			],
		});
		const result = formatDiscordMessage(msg);
		expect(result).toContain("[添付: undefined (image/png) https://example.com/img.png]");
	});

	test("attachments が空配列の場合、添付テキストは出力に含まれない", () => {
		const msg = createMessage({ attachments: [] });
		const result = formatDiscordMessage(msg);
		expect(result).not.toContain("[添付:");
	});

	test("複数の添付はスペース区切りで連結される", () => {
		const msg = createMessage({
			attachments: [
				{ url: "https://example.com/a.png", contentType: "image/png", filename: "a.png" },
				{ url: "https://example.com/b.jpg", contentType: "image/jpeg", filename: "b.jpg" },
			],
		});
		const result = formatDiscordMessage(msg);
		expect(result).toContain("[添付: a.png (image/png) https://example.com/a.png]");
		expect(result).toContain("[添付: b.jpg (image/jpeg) https://example.com/b.jpg]");
	});
});
