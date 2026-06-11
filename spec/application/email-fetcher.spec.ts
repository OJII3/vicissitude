import { describe, expect, test } from "bun:test";

import { formatEmailContext } from "@vicissitude/application/email-fetcher";
import type { EmailCheckResult } from "@vicissitude/application/email-fetcher";

function makeResult(overrides: Partial<EmailCheckResult> = {}): EmailCheckResult {
	return {
		hasNewMail: true,
		count: 1,
		emails: [
			{
				subject: "件名",
				from: "alice@example.com",
				date: "2026-06-10T09:00:00Z",
				bodyExcerpt: "本文の抜粋",
			},
		],
		...overrides,
	};
}

describe("formatEmailContext", () => {
	test("新着メールが無ければ空文字を返す", () => {
		const result = makeResult({ hasNewMail: false, count: 0, emails: [] });

		expect(formatEmailContext(result)).toBe("");
	});

	test("hasNewMail=true でも emails が空なら空文字を返す", () => {
		const result = makeResult({ hasNewMail: true, count: 0, emails: [] });

		expect(formatEmailContext(result)).toBe("");
	});

	test("出力全体を <email_context> デリミタで囲む（プロンプトインジェクション対策）", () => {
		const output = formatEmailContext(makeResult());

		expect(output.startsWith("<email_context>")).toBe(true);
		expect(output.endsWith("</email_context>")).toBe(true);
	});

	test("件名・差出人・本文抜粋を含む", () => {
		const output = formatEmailContext(makeResult());

		expect(output).toContain("件名");
		expect(output).toContain("alice@example.com");
		expect(output).toContain("本文の抜粋");
	});

	test("bodyExcerpt は 200 文字でトランケートする", () => {
		const longBody = "あ".repeat(500);
		const output = formatEmailContext(
			makeResult({
				emails: [
					{
						subject: "長文",
						from: "bob@example.com",
						date: "2026-06-10T09:00:00Z",
						bodyExcerpt: longBody,
					},
				],
			}),
		);

		// トランケート後の本文は 200 文字以下（元の 500 文字は含まれない）
		expect(output).not.toContain("あ".repeat(201));
		expect(output).toContain("あ".repeat(200));
	});

	test("複数メールを件数とともに列挙する", () => {
		const output = formatEmailContext(
			makeResult({
				count: 2,
				emails: [
					{
						subject: "一通目",
						from: "a@example.com",
						date: "2026-06-10T09:00:00Z",
						bodyExcerpt: "body1",
					},
					{
						subject: "二通目",
						from: "b@example.com",
						date: "2026-06-10T10:00:00Z",
						bodyExcerpt: "body2",
					},
				],
			}),
		);

		expect(output).toContain("2");
		expect(output).toContain("一通目");
		expect(output).toContain("二通目");
	});
});
