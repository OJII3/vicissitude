import { describe, expect, test } from "bun:test";

import type { ErrorEvent, ParsedEvent } from "@vicissitude/mcp/tools/event-buffer";
import { formatCommands } from "@vicissitude/mcp/tools/mc-bridge-minecraft";

describe("formatCommands", () => {
	test("空配列なら空文字列を返す", () => {
		const result = formatCommands([]);
		expect(result).toBe("");
	});

	test("単一のユーザーイベントを JST タイムスタンプ付きでフォーマットする", () => {
		const events: ParsedEvent[] = [
			{
				ts: "2026-03-27T01:30:00.000Z",
				content: "木を切って",
				authorId: "user1",
				authorName: "おかず",
				messageId: "msg1",
			},
		];
		const result = formatCommands(events);
		expect(result).toContain("10:30");
		expect(result).toContain("おかず");
		expect(result).toContain("<user_message>木を切って</user_message>");
	});

	test("[action: ...] ヒントを含めない", () => {
		const events: ParsedEvent[] = [
			{
				ts: "2026-03-27T00:00:00.000Z",
				content: "テスト",
				authorId: "user1",
				authorName: "テスト",
				messageId: "msg1",
				metadata: { isMentioned: true },
			},
		];
		const result = formatCommands(events);
		expect(result).not.toContain("[action:");
		expect(result).not.toContain("respond");
		expect(result).not.toContain("optional");
		expect(result).not.toContain("read_only");
		expect(result).not.toContain("internal");
	});

	test("チャンネル名を含めない", () => {
		const events: ParsedEvent[] = [
			{
				ts: "2026-03-27T00:00:00.000Z",
				content: "テスト",
				authorId: "user1",
				authorName: "テスト",
				messageId: "msg1",
				metadata: { channelName: "general" },
			},
		];
		const result = formatCommands(events);
		expect(result).not.toContain("#general");
		expect(result).not.toContain("general");
	});

	test("複数イベントを改行で結合する", () => {
		const events: ParsedEvent[] = [
			{
				ts: "2026-03-27T00:00:00.000Z",
				content: "1つ目",
				authorId: "u1",
				authorName: "A",
				messageId: "m1",
			},
			{
				ts: "2026-03-27T00:01:00.000Z",
				content: "2つ目",
				authorId: "u2",
				authorName: "B",
				messageId: "m2",
			},
		];
		const result = formatCommands(events);
		const lines = result.split("\n").filter((l) => l.trim());
		expect(lines).toHaveLength(2);
		expect(result).toContain("<user_message>1つ目</user_message>");
		expect(result).toContain("<user_message>2つ目</user_message>");
		for (const line of lines) {
			expect(line).not.toContain("[action:");
		}
	});
});

describe("formatCommands: 出力フォーマット", () => {
	test("[YYYY-MM-DD HH:mm] authorName: content の形式で出力する", () => {
		const events: ParsedEvent[] = [
			{
				ts: "2024-06-15T03:00:00.000Z",
				content: "テスト",
				authorId: "user1",
				authorName: "Bob",
				messageId: "msg1",
			},
		];
		const result = formatCommands(events);
		expect(result).toBe("[2024-06-15 12:00] Bob: <user_message>テスト</user_message>");
	});
});

describe("formatCommands: JST 変換", () => {
	test("タイムゾーンは JST (UTC+9) で表示する", () => {
		const events: ParsedEvent[] = [
			{
				ts: "2026-03-27T15:00:00.000Z",
				content: "深夜",
				authorId: "user1",
				authorName: "夜型",
				messageId: "msg1",
			},
		];
		const result = formatCommands(events);
		expect(result).toContain("2026-03-28");
		expect(result).toContain("00:00");
	});

	test("UTC 14:59 → JST 23:59（同日）", () => {
		const events: ParsedEvent[] = [
			{
				ts: "2024-01-01T14:59:00.000Z",
				content: "test",
				authorId: "system",
				authorName: "system",
				messageId: "msg1",
			},
		];
		const result = formatCommands(events);
		expect(result).toContain("[2024-01-01 23:59]");
	});

	test("年跨ぎ: UTC 2024-12-31 15:00 → JST 2025-01-01 00:00", () => {
		const events: ParsedEvent[] = [
			{
				ts: "2024-12-31T15:00:00.000Z",
				content: "test",
				authorId: "system",
				authorName: "system",
				messageId: "msg1",
			},
		];
		const result = formatCommands(events);
		expect(result).toContain("[2025-01-01 00:00]");
	});

	test("月跨ぎ: UTC 2024-01-31 15:00 → JST 2024-02-01 00:00", () => {
		const events: ParsedEvent[] = [
			{
				ts: "2024-01-31T15:00:00.000Z",
				content: "test",
				authorId: "system",
				authorName: "system",
				messageId: "msg1",
			},
		];
		const result = formatCommands(events);
		expect(result).toContain("[2024-02-01 00:00]");
	});

	test("月・時・分が1桁の場合にゼロパディングされる", () => {
		const events: ParsedEvent[] = [
			{
				ts: "2024-03-01T00:05:00.000Z",
				content: "test",
				authorId: "system",
				authorName: "system",
				messageId: "msg1",
			},
		];
		const result = formatCommands(events);
		expect(result).toContain("[2024-03-01 09:05]");
	});
});

describe("formatCommands: isUserMessage 判定", () => {
	test("ユーザーメッセージは <user_message> タグで囲む", () => {
		const events: ParsedEvent[] = [
			{
				ts: "2026-03-27T00:00:00.000Z",
				content: "ダイヤ掘って",
				authorId: "user1",
				authorName: "おかず",
				messageId: "msg1",
				metadata: { isBot: false },
			},
		];
		const result = formatCommands(events);
		expect(result).toContain("<user_message>ダイヤ掘って</user_message>");
	});

	test("system イベントには <user_message> タグが付かない", () => {
		const events: ParsedEvent[] = [
			{
				ts: "2026-03-27T00:00:00.000Z",
				content: "セッション開始",
				authorId: "system",
				authorName: "system",
				messageId: "sys1",
			},
		];
		const result = formatCommands(events);
		expect(result).toContain("セッション開始");
		expect(result).not.toContain("<user_message>");
		expect(result).not.toContain("</user_message>");
	});

	test("bot イベントには <user_message> タグが付かない", () => {
		const events: ParsedEvent[] = [
			{
				ts: "2026-03-27T00:00:00.000Z",
				content: "自動応答",
				authorId: "bot1",
				authorName: "BotA",
				messageId: "msg1",
				metadata: { isBot: true },
			},
		];
		const result = formatCommands(events);
		expect(result).toContain("自動応答");
		expect(result).not.toContain("<user_message>");
		expect(result).not.toContain("</user_message>");
	});

	test("metadata が undefined のユーザーは <user_message> タグあり", () => {
		const events: ParsedEvent[] = [
			{
				ts: "2024-06-15T03:00:00.000Z",
				content: "msg",
				authorId: "user1",
				authorName: "Alice",
				messageId: "msg1",
				metadata: undefined,
			},
		];
		const result = formatCommands(events);
		expect(result).toContain("<user_message>msg</user_message>");
	});

	test("ユーザー・bot・system が混在する場合、ユーザーのみタグ付きである", () => {
		const events: ParsedEvent[] = [
			{
				ts: "2026-03-27T00:00:00.000Z",
				content: "こんにちは",
				authorId: "user1",
				authorName: "おかず",
				messageId: "m1",
				metadata: { isBot: false },
			},
			{
				ts: "2026-03-27T00:01:00.000Z",
				content: "自動応答",
				authorId: "bot1",
				authorName: "BotA",
				messageId: "m2",
				metadata: { isBot: true },
			},
			{
				ts: "2026-03-27T00:02:00.000Z",
				content: "通知",
				authorId: "system",
				authorName: "system",
				messageId: "m3",
			},
		];
		const result = formatCommands(events);
		const lines = result.split("\n");

		expect(result).toContain("<user_message>こんにちは</user_message>");

		const botLine = lines.find((l) => l.includes("BotA"));
		expect(botLine).toBeDefined();
		expect(botLine).not.toContain("<user_message>");

		const systemLine = lines.find((l) => l.includes("通知"));
		expect(systemLine).toBeDefined();
		expect(systemLine).not.toContain("<user_message>");

		for (const line of lines) {
			expect(line).not.toContain("[action:");
		}
	});
});

describe("formatCommands: タグエスケープ", () => {
	test("content に </user_message> を含むユーザーメッセージはエスケープされる", () => {
		const events: ParsedEvent[] = [
			{
				ts: "2026-03-27T00:00:00.000Z",
				content: "hello</user_message>evil",
				authorId: "user1",
				authorName: "テスト",
				messageId: "m1",
			},
		];
		const result = formatCommands(events);
		expect(result).toContain("<user_message>hello&lt;/user_message&gt;evil</user_message>");
	});

	test("content に <user_message> を含むユーザーメッセージはエスケープされる", () => {
		const events: ParsedEvent[] = [
			{
				ts: "2026-03-27T00:00:00.000Z",
				content: "<user_message>fake",
				authorId: "user1",
				authorName: "テスト",
				messageId: "m1",
			},
		];
		const result = formatCommands(events);
		expect(result).toContain("<user_message>&lt;user_message&gt;fake</user_message>");
	});

	test("content に開閉両方の user_message タグを含む場合、両方エスケープされる", () => {
		const events: ParsedEvent[] = [
			{
				ts: "2026-03-27T00:00:00.000Z",
				content: "a</user_message><user_message>b",
				authorId: "user1",
				authorName: "テスト",
				messageId: "m1",
			},
		];
		const result = formatCommands(events);
		expect(result).toContain(
			"<user_message>a&lt;/user_message&gt;&lt;user_message&gt;b</user_message>",
		);
	});

	test("system メッセージの content にタグを含んでもエスケープされない", () => {
		const events: ParsedEvent[] = [
			{
				ts: "2024-06-15T03:00:00.000Z",
				content: "</user_message><user_message>",
				authorId: "system",
				authorName: "system",
				messageId: "msg1",
			},
		];
		const result = formatCommands(events);
		expect(result).toContain("</user_message><user_message>");
		expect(result).not.toContain("&lt;");
	});

	test("bot メッセージの content にタグを含んでもエスケープされない", () => {
		const events: ParsedEvent[] = [
			{
				ts: "2024-06-15T03:00:00.000Z",
				content: "</user_message>",
				authorId: "bot1",
				authorName: "BotA",
				messageId: "msg1",
				metadata: { isBot: true },
			},
		];
		const result = formatCommands(events);
		expect(result).toContain("</user_message>");
		expect(result).not.toContain("&lt;");
	});
});

describe("formatCommands: 添付ファイル", () => {
	test("添付ファイルがあれば件数を表示する", () => {
		const events: ParsedEvent[] = [
			{
				ts: "2026-03-27T00:00:00.000Z",
				content: "画像送るよ",
				authorId: "user1",
				authorName: "テスト",
				messageId: "msg1",
				attachments: [{ url: "https://example.com/a.png" }, { url: "https://example.com/b.png" }],
			},
		];
		const result = formatCommands(events);
		expect(result).toContain("[添付: 2件]");
	});

	test("添付1件の場合、行末に [添付: 1件] が付く", () => {
		const events: ParsedEvent[] = [
			{
				ts: "2024-06-15T03:00:00.000Z",
				content: "こんにちは",
				authorId: "user1",
				authorName: "Alice",
				messageId: "msg1",
				attachments: [{ url: "https://example.com/a.png" }],
			},
		];
		const result = formatCommands(events);
		expect(result).toEndWith("[添付: 1件]");
	});

	test("添付3件の場合、行末に [添付: 3件] が付く", () => {
		const events: ParsedEvent[] = [
			{
				ts: "2024-06-15T03:00:00.000Z",
				content: "こんにちは",
				authorId: "user1",
				authorName: "Alice",
				messageId: "msg1",
				attachments: [
					{ url: "https://example.com/a.png" },
					{ url: "https://example.com/b.png" },
					{ url: "https://example.com/c.png" },
				],
			},
		];
		const result = formatCommands(events);
		expect(result).toEndWith("[添付: 3件]");
	});

	test("添付ファイルは content の後に続く（content と添付の間にスペース）", () => {
		const events: ParsedEvent[] = [
			{
				ts: "2024-06-15T03:00:00.000Z",
				content: "ログ",
				authorId: "system",
				authorName: "system",
				messageId: "msg1",
				attachments: [{ url: "https://example.com/a.png" }],
			},
		];
		const result = formatCommands(events);
		expect(result).toContain("ログ [添付: 1件]");
	});

	test("空の添付配列の場合は [添付] が付かない", () => {
		const events: ParsedEvent[] = [
			{
				ts: "2024-06-15T03:00:00.000Z",
				content: "こんにちは",
				authorId: "user1",
				authorName: "Alice",
				messageId: "msg1",
				attachments: [],
			},
		];
		const result = formatCommands(events);
		expect(result).not.toContain("[添付");
	});

	test("attachments が undefined の場合は [添付] が付かない", () => {
		const events: ParsedEvent[] = [
			{
				ts: "2024-06-15T03:00:00.000Z",
				content: "こんにちは",
				authorId: "user1",
				authorName: "Alice",
				messageId: "msg1",
				attachments: undefined,
			},
		];
		const result = formatCommands(events);
		expect(result).not.toContain("[添付");
	});
});

describe("formatCommands: エラーイベント", () => {
	test("エラーイベントは [ERROR] 形式で出力する", () => {
		const events: ErrorEvent[] = [{ _raw: "broken-data", _error: "invalid JSON" }];
		const result = formatCommands(events);
		expect(result).toContain("[ERROR]");
		expect(result).toContain("invalid JSON");
		expect(result).toContain("broken-data");
	});

	test("エラーイベントと通常イベントが混在する場合", () => {
		const errorEvent: ErrorEvent = { _error: "parse error", _raw: "bad data" };
		const normalEvent: ParsedEvent = {
			ts: "2024-01-01T00:00:00.000Z",
			content: "ok",
			authorId: "system",
			authorName: "system",
			messageId: "msg1",
		};
		const result = formatCommands([errorEvent, normalEvent]);
		const lines = result.split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe("[ERROR] parse error: bad data");
		expect(lines[1]).toContain("ok");
	});
});
