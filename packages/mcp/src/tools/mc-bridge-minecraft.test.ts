import { describe, expect, test } from "bun:test";

import type { ParsedEvent } from "./event-buffer.ts";
import { formatCommands } from "./mc-bridge-minecraft.ts";

// ─── Test Helpers ────────────────────────────────────────────────

function makeEvent(overrides: Partial<ParsedEvent> = {}): ParsedEvent {
	return {
		ts: "2024-06-15T03:00:00.000Z",
		content: "こんにちは",
		authorId: "user-1",
		authorName: "Alice",
		messageId: "msg-1",
		...overrides,
	};
}

// ─── 空配列 ──────────────────────────────────────────────────────

describe("formatCommands", () => {
	test("空配列は空文字列を返す", () => {
		expect(formatCommands([])).toBe("");
	});

	// ─── JST 変換のエッジケース ──────────────────────────────────

	describe("toJstString の JST 変換（formatCommands 経由）", () => {
		test("UTC 14:59 → JST 23:59（同日）", () => {
			const result = formatCommands([makeEvent({ ts: "2024-01-01T14:59:00.000Z" })]);
			expect(result).toContain("[2024-01-01 23:59]");
		});

		test("UTC 15:00 → JST 翌日 00:00（日付境界）", () => {
			const result = formatCommands([makeEvent({ ts: "2024-01-01T15:00:00.000Z" })]);
			expect(result).toContain("[2024-01-02 00:00]");
		});

		test("年跨ぎ: UTC 2024-12-31 15:00 → JST 2025-01-01 00:00", () => {
			const result = formatCommands([makeEvent({ ts: "2024-12-31T15:00:00.000Z" })]);
			expect(result).toContain("[2025-01-01 00:00]");
		});

		test("月跨ぎ: UTC 2024-01-31 15:00 → JST 2024-02-01 00:00", () => {
			const result = formatCommands([makeEvent({ ts: "2024-01-31T15:00:00.000Z" })]);
			expect(result).toContain("[2024-02-01 00:00]");
		});

		test("月・時・分が1桁の場合にゼロパディングされる", () => {
			// UTC 2024-03-01T00:05:00Z → JST 2024-03-01 09:05
			const result = formatCommands([makeEvent({ ts: "2024-03-01T00:05:00.000Z" })]);
			expect(result).toContain("[2024-03-01 09:05]");
		});
	});

	// ─── 出力フォーマット ────────────────────────────────────────

	describe("出力フォーマットの厳密な文字列一致", () => {
		test("[YYYY-MM-DD HH:mm] authorName: content の形式で出力する", () => {
			const result = formatCommands([
				makeEvent({
					ts: "2024-06-15T03:00:00.000Z",
					authorName: "Bob",
					content: "テスト",
					authorId: "user-1",
				}),
			]);
			// UTC 03:00 + 9h = JST 12:00
			expect(result).toBe("[2024-06-15 12:00] Bob: <user_message>テスト</user_message>");
		});

		test("複数イベントは改行で結合される", () => {
			const result = formatCommands([
				makeEvent({ ts: "2024-01-01T00:00:00.000Z", authorName: "A", content: "1" }),
				makeEvent({ ts: "2024-01-01T01:00:00.000Z", authorName: "B", content: "2" }),
			]);
			const lines = result.split("\n");
			expect(lines).toHaveLength(2);
			expect(lines[0]).toContain("A:");
			expect(lines[1]).toContain("B:");
		});
	});

	// ─── isUserMessage 判定 ──────────────────────────────────────

	describe("isUserMessage 判定の分岐", () => {
		test("通常ユーザーのメッセージは <user_message> タグで囲まれる", () => {
			const result = formatCommands([makeEvent({ authorId: "user-1", content: "hello" })]);
			expect(result).toContain("<user_message>hello</user_message>");
		});

		test("system authorId のメッセージは <user_message> タグなし", () => {
			const result = formatCommands([makeEvent({ authorId: "system", content: "info" })]);
			expect(result).not.toContain("<user_message>");
			expect(result).toContain("info");
		});

		test("isBot: true のメッセージは <user_message> タグなし", () => {
			const result = formatCommands([
				makeEvent({
					authorId: "bot-1",
					content: "bot msg",
					metadata: { isBot: true },
				}),
			]);
			expect(result).not.toContain("<user_message>");
			expect(result).toContain("bot msg");
		});

		test("isBot: false のユーザーは <user_message> タグあり", () => {
			const result = formatCommands([
				makeEvent({
					authorId: "user-1",
					content: "msg",
					metadata: { isBot: false },
				}),
			]);
			expect(result).toContain("<user_message>msg</user_message>");
		});

		test("metadata が undefined のユーザーは <user_message> タグあり", () => {
			const result = formatCommands([
				makeEvent({ authorId: "user-1", content: "msg", metadata: undefined }),
			]);
			expect(result).toContain("<user_message>msg</user_message>");
		});
	});

	// ─── 添付ファイル ────────────────────────────────────────────

	describe("添付ファイル表示", () => {
		test("添付1件の場合、行末に [添付: 1件] が付く", () => {
			const result = formatCommands([
				makeEvent({
					attachments: [{ url: "https://example.com/a.png" }],
				}),
			]);
			expect(result).toEndWith("[添付: 1件]");
		});

		test("添付3件の場合、行末に [添付: 3件] が付く", () => {
			const result = formatCommands([
				makeEvent({
					attachments: [
						{ url: "https://example.com/a.png" },
						{ url: "https://example.com/b.png" },
						{ url: "https://example.com/c.png" },
					],
				}),
			]);
			expect(result).toEndWith("[添付: 3件]");
		});

		test("添付ファイルは content の後に続く（content と添付の間にスペース）", () => {
			const result = formatCommands([
				makeEvent({
					authorId: "system",
					content: "ログ",
					attachments: [{ url: "https://example.com/a.png" }],
				}),
			]);
			expect(result).toContain("ログ [添付: 1件]");
		});

		test("空の添付配列の場合は [添付] が付かない", () => {
			const result = formatCommands([makeEvent({ attachments: [] })]);
			expect(result).not.toContain("[添付");
		});

		test("attachments が undefined の場合は [添付] が付かない", () => {
			const result = formatCommands([makeEvent({ attachments: undefined })]);
			expect(result).not.toContain("[添付");
		});
	});

	// ─── エラーイベント ──────────────────────────────────────────

	describe("エラーイベント", () => {
		test("_error と _raw を持つオブジェクトは [ERROR] err: raw 形式で出力する", () => {
			const errorEvent = { _error: "invalid JSON", _raw: "{broken" } as never;
			const result = formatCommands([errorEvent]);
			expect(result).toBe("[ERROR] invalid JSON: {broken");
		});

		test("エラーイベントと通常イベントが混在する場合", () => {
			const errorEvent = { _error: "parse error", _raw: "bad data" } as never;
			const normalEvent = makeEvent({
				ts: "2024-01-01T00:00:00.000Z",
				authorId: "system",
				content: "ok",
			});
			const result = formatCommands([errorEvent, normalEvent]);
			const lines = result.split("\n");
			expect(lines).toHaveLength(2);
			expect(lines[0]).toBe("[ERROR] parse error: bad data");
			expect(lines[1]).toContain("ok");
		});
	});
});
