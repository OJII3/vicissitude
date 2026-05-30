/* oxlint-disable max-lines-per-function -- テストファイルはケース数に応じて長くなるため許容 */
import { describe, expect, test } from "bun:test";

import type { IncomingMessage } from "@vicissitude/shared/types";

import { formatDiscordMessage } from "./message-formatter.ts";

function* trustedIdGenerator(): Generator<string> {
	yield "alpha";
	yield "beta";
}

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
	test("画像添付は URL を含めず [添付: filename (contentType)] としてフォーマットされる", () => {
		const msg = createMessage({
			attachments: [
				{ url: undefined as unknown as string, contentType: "image/png", filename: "photo.png" },
			],
		});
		const result = formatDiscordMessage(msg);
		expect(result).toContain("[添付: photo.png (image/png)]");
		expect(result).not.toContain("undefined]");
	});

	test("contentType が undefined の添付は URL を含めてフォーマットされる", () => {
		const msg = createMessage({
			attachments: [
				{ url: "https://example.com/file.bin", contentType: undefined, filename: "file.bin" },
			],
		});
		const result = formatDiscordMessage(msg);
		expect(result).toContain("[添付: file.bin (undefined) https://example.com/file.bin]");
	});

	test("filename が undefined でも画像添付は URL を含めない", () => {
		const msg = createMessage({
			attachments: [
				{ url: "https://example.com/img.png", contentType: "image/png", filename: undefined },
			],
		});
		const result = formatDiscordMessage(msg);
		expect(result).toContain("[添付: undefined (image/png)]");
		expect(result).not.toContain("https://example.com/img.png");
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
				{ url: "https://example.com/b.txt", contentType: "text/plain", filename: "b.txt" },
			],
		});
		const result = formatDiscordMessage(msg);
		expect(result).toContain("[添付: a.png (image/png)]");
		expect(result).not.toContain("https://example.com/a.png");
		expect(result).toContain("[添付: b.txt (text/plain) https://example.com/b.txt]");
	});
});

describe("formatDiscordMessage 信頼マーカー（内部分岐）", () => {
	const MARKER = "[trusted-requester]";

	test("複数 ID の途中に authorId が一致するとき（ループが中間要素でヒット）マーカーが付く", () => {
		const msg = createMessage({ authorId: "mid" });
		const result = formatDiscordMessage(msg, {
			trustedUserIds: ["first", "mid", "last"],
		});
		expect(result).toContain(MARKER);
	});

	test("複数 ID のいずれにも authorId が一致しないとき（ループ完走で false）マーカーが付かない", () => {
		const msg = createMessage({ authorId: "none" });
		const result = formatDiscordMessage(msg, {
			trustedUserIds: ["a", "b", "c"],
		});
		expect(result).not.toContain(MARKER);
	});

	test("Set で渡しても配列と同じく一致すればマーカーが付く（Iterable の形に依存しない）", () => {
		const msg = createMessage({ authorId: "x" });
		const result = formatDiscordMessage(msg, {
			trustedUserIds: new Set(["x", "y"]),
		});
		expect(result).toContain(MARKER);
	});

	test("ジェネレータ（任意の Iterable）で渡しても一致すればマーカーが付く", () => {
		const msg = createMessage({ authorId: "beta" });
		const result = formatDiscordMessage(msg, { trustedUserIds: trustedIdGenerator() });
		expect(result).toContain(MARKER);
	});

	test("Set と配列で同一内容なら判定結果が一致する", () => {
		const msg = createMessage({ authorId: "z" });
		const fromArray = formatDiscordMessage(msg, { trustedUserIds: ["z"] });
		const fromSet = formatDiscordMessage(msg, { trustedUserIds: new Set(["z"]) });
		expect(fromArray.includes(MARKER)).toBe(fromSet.includes(MARKER));
		expect(fromArray).toContain(MARKER);
	});

	test("authorId が 'system' で信頼集合に含まれないときマーカーが付かない", () => {
		const msg = createMessage({ authorId: "system" });
		const result = formatDiscordMessage(msg, { trustedUserIds: ["user-1"] });
		expect(result).not.toContain(MARKER);
	});

	test("authorId が 'system' でも信頼集合に 'system' が含まれれば authorId 照合でマーカーが付く", () => {
		const msg = createMessage({ authorId: "system" });
		const result = formatDiscordMessage(msg, { trustedUserIds: ["system"] });
		expect(result).toContain(MARKER);
	});

	test("bot メッセージでも authorId が信頼集合に含まれなければマーカーが付かない", () => {
		const msg = createMessage({ isBot: true, authorId: "bot-1" });
		const result = formatDiscordMessage(msg, { trustedUserIds: ["user-1"] });
		expect(result).not.toContain(MARKER);
	});

	test("空 Set のときマーカーが付かない", () => {
		const msg = createMessage({ authorId: "user-1" });
		const result = formatDiscordMessage(msg, { trustedUserIds: new Set() });
		expect(result).not.toContain(MARKER);
	});

	test("文字列の照合は厳密一致（部分一致や型強制では一致しない）", () => {
		const msg = createMessage({ authorId: "123" });
		const result = formatDiscordMessage(msg, { trustedUserIds: ["1234", "0123"] });
		expect(result).not.toContain(MARKER);
	});

	test("マーカーは [action: ...] より後ろ（末尾側）に付く", () => {
		const msg = createMessage({ authorId: "user-1" });
		const result = formatDiscordMessage(msg, { trustedUserIds: ["user-1"] });
		expect(result.indexOf(MARKER)).toBeGreaterThan(result.indexOf("[action:"));
	});

	test("添付・user_message ラップと共存しても末尾にマーカーが付く（user メッセージ）", () => {
		const msg = createMessage({
			authorId: "user-1",
			content: "本文",
			attachments: [
				{ url: "https://example.com/a.txt", contentType: "text/plain", filename: "a.txt" },
			],
		});
		const result = formatDiscordMessage(msg, { trustedUserIds: ["user-1"] });
		expect(result).toContain("<user_message>");
		expect(result).toContain("[添付: a.txt (text/plain) https://example.com/a.txt]");
		expect(result.endsWith(MARKER)).toBe(true);
	});

	test("bot メッセージで信頼集合に含まれる場合、マーカーは bot-interaction-hint より前に付く", () => {
		const msg = createMessage({ isBot: true, authorId: "bot-1" });
		const result = formatDiscordMessage(msg, { trustedUserIds: ["bot-1"] });
		expect(result).toContain(MARKER);
		expect(result.indexOf(MARKER)).toBeLessThan(result.indexOf("[bot-interaction-hint:"));
	});
});
