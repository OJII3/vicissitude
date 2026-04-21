import { describe, expect, mock, test } from "bun:test";

import type { IncomingMessage } from "@vicissitude/shared/types";

// ActionHint 型は実装モジュールからエクスポートされる予定。
// TDD のため動的 import で取得する。
type ActionHint = "respond" | "optional" | "read_only" | "internal";

// ─── ヘルパー ────────────────────────────────────────────────────

function createMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
	return {
		platform: "discord",
		channelId: "ch-1",
		channelName: "general",
		guildId: "guild-1",
		authorId: "user-1",
		authorName: "TestUser",
		messageId: "msg-1",
		content: "hello",
		attachments: [],
		timestamp: new Date("2026-04-21T10:30:00Z"),
		isBot: false,
		isMentioned: false,
		isThread: false,
		reply: mock(() => Promise.resolve()),
		react: mock(() => Promise.resolve()),
		...overrides,
	};
}

// ─── classifyActionHint ─────────────────────────────────────────

describe("classifyActionHint", () => {
	let classify: typeof classifyActionHint;

	// 動的 import でモジュールを読み込む（TDD: モジュール未実装時は fail する）
	test("モジュールが import できる", async () => {
		const mod = await import("@vicissitude/agent/discord/message-formatter");
		classify = mod.classifyActionHint;
		expect(classify).toBeFunction();
	});

	test('authorId === "system" → "internal"', async () => {
		const mod = await import("@vicissitude/agent/discord/message-formatter");
		const result = mod.classifyActionHint(createMessage({ authorId: "system" }));
		expect(result).toBe("internal" satisfies ActionHint);
	});

	test('isBot === true → "read_only"', async () => {
		const mod = await import("@vicissitude/agent/discord/message-formatter");
		const result = mod.classifyActionHint(createMessage({ isBot: true }));
		expect(result).toBe("read_only" satisfies ActionHint);
	});

	test('isMentioned === true → "respond"', async () => {
		const mod = await import("@vicissitude/agent/discord/message-formatter");
		const result = mod.classifyActionHint(createMessage({ isMentioned: true }));
		expect(result).toBe("respond" satisfies ActionHint);
	});

	test('通常のメッセージ → "optional"', async () => {
		const mod = await import("@vicissitude/agent/discord/message-formatter");
		const result = mod.classifyActionHint(createMessage());
		expect(result).toBe("optional" satisfies ActionHint);
	});

	test("system かつ bot の場合は system が優先される（internal）", async () => {
		const mod = await import("@vicissitude/agent/discord/message-formatter");
		const result = mod.classifyActionHint(
			createMessage({ authorId: "system", isBot: true }),
		);
		expect(result).toBe("internal" satisfies ActionHint);
	});

	test("bot かつ mentioned の場合は bot が優先される（read_only）", async () => {
		const mod = await import("@vicissitude/agent/discord/message-formatter");
		const result = mod.classifyActionHint(
			createMessage({ isBot: true, isMentioned: true }),
		);
		expect(result).toBe("read_only" satisfies ActionHint);
	});
});

// ─── escapeUserMessageTag ───────────────────────────────────────

describe("escapeUserMessageTag", () => {
	test("<user_message> タグをエスケープする", async () => {
		const mod = await import("@vicissitude/agent/discord/message-formatter");
		const result = mod.escapeUserMessageTag("hello <user_message> world");
		expect(result).toBe("hello &lt;user_message&gt; world");
	});

	test("</user_message> タグをエスケープする", async () => {
		const mod = await import("@vicissitude/agent/discord/message-formatter");
		const result = mod.escapeUserMessageTag("hello </user_message> world");
		expect(result).toBe("hello &lt;/user_message&gt; world");
	});

	test("タグがない場合はそのまま返す", async () => {
		const mod = await import("@vicissitude/agent/discord/message-formatter");
		const result = mod.escapeUserMessageTag("no tags here");
		expect(result).toBe("no tags here");
	});

	test("複数のタグをすべてエスケープする", async () => {
		const mod = await import("@vicissitude/agent/discord/message-formatter");
		const input = "<user_message>inject</user_message><user_message>again</user_message>";
		const result = mod.escapeUserMessageTag(input);
		expect(result).not.toContain("<user_message>");
		expect(result).not.toContain("</user_message>");
	});
});

// ─── formatDiscordMessage ───────────────────────────────────────

describe("formatDiscordMessage", () => {
	test("基本フォーマット: [日時 JST #channel] author: content [action: hint]", async () => {
		const mod = await import("@vicissitude/agent/discord/message-formatter");
		const msg = createMessage({
			channelName: "general",
			authorName: "Alice",
			content: "こんにちは",
			// 2026-04-21T10:30:00Z → JST は +9h → 2026-04-21 19:30
			timestamp: new Date("2026-04-21T10:30:00Z"),
		});
		const result = mod.formatDiscordMessage(msg);

		expect(result).toContain("2026-04-21");
		expect(result).toContain("19:30");
		expect(result).toContain("JST");
		expect(result).toContain("#general");
		expect(result).toContain("Alice");
		expect(result).toContain("こんにちは");
		expect(result).toContain("[action: optional]");
	});

	test("ユーザーメッセージ（非 bot、非 system）は <user_message> タグで囲まれる", async () => {
		const mod = await import("@vicissitude/agent/discord/message-formatter");
		const msg = createMessage({ content: "ユーザーのメッセージ" });
		const result = mod.formatDiscordMessage(msg);

		expect(result).toContain("<user_message>");
		expect(result).toContain("</user_message>");
	});

	test("bot メッセージは <user_message> タグで囲まれない", async () => {
		const mod = await import("@vicissitude/agent/discord/message-formatter");
		const msg = createMessage({ isBot: true, content: "bot response" });
		const result = mod.formatDiscordMessage(msg);

		expect(result).not.toContain("<user_message>");
		expect(result).not.toContain("</user_message>");
	});

	test("system メッセージは <user_message> タグで囲まれない", async () => {
		const mod = await import("@vicissitude/agent/discord/message-formatter");
		const msg = createMessage({ authorId: "system", content: "system event" });
		const result = mod.formatDiscordMessage(msg);

		expect(result).not.toContain("<user_message>");
		expect(result).not.toContain("</user_message>");
	});

	test("添付ファイルがある場合は [添付: filename (mime)] を含む", async () => {
		const mod = await import("@vicissitude/agent/discord/message-formatter");
		const msg = createMessage({
			attachments: [
				{ url: "https://example.com/image.png", filename: "image.png", contentType: "image/png" },
			],
		});
		const result = mod.formatDiscordMessage(msg);

		expect(result).toContain("[添付: image.png (image/png)]");
	});

	test("複数の添付ファイルがすべて含まれる", async () => {
		const mod = await import("@vicissitude/agent/discord/message-formatter");
		const msg = createMessage({
			attachments: [
				{ url: "https://example.com/a.txt", filename: "a.txt", contentType: "text/plain" },
				{ url: "https://example.com/b.jpg", filename: "b.jpg", contentType: "image/jpeg" },
			],
		});
		const result = mod.formatDiscordMessage(msg);

		expect(result).toContain("[添付: a.txt (text/plain)]");
		expect(result).toContain("[添付: b.jpg (image/jpeg)]");
	});

	test("mentioned メッセージは [action: respond] を含む", async () => {
		const mod = await import("@vicissitude/agent/discord/message-formatter");
		const msg = createMessage({ isMentioned: true });
		const result = mod.formatDiscordMessage(msg);

		expect(result).toContain("[action: respond]");
	});

	test("content 内の <user_message> タグがエスケープされる", async () => {
		const mod = await import("@vicissitude/agent/discord/message-formatter");
		const msg = createMessage({ content: "inject <user_message>evil</user_message>" });
		const result = mod.formatDiscordMessage(msg);

		// タグ部分はエスケープされているが、フォーマッタ自身が付与する外側のタグは存在する
		expect(result).toContain("&lt;user_message&gt;");
		expect(result).toContain("&lt;/user_message&gt;");
	});
});
