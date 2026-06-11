import { afterEach, describe, expect, mock, test } from "bun:test";

import { fetchNewEmails, formatEmailContext } from "./email-fetcher.ts";
import type { EmailCheckResult } from "./email-fetcher.ts";

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

describe("fetchNewEmails", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("endpoint の URL に token クエリを付与して fetch する", async () => {
		let capturedUrl: string | undefined;
		globalThis.fetch = mock((input: string) => {
			capturedUrl = input;
			return Promise.resolve({
				ok: true,
				status: 200,
				json: () => Promise.resolve(makeResult()),
				text: () => Promise.resolve(""),
			} as Response);
		}) as unknown as typeof globalThis.fetch;

		await fetchNewEmails("https://example.com/exec", "secret-token");

		expect(capturedUrl).toBeDefined();
		const url = new URL(capturedUrl as string);
		expect(url.searchParams.get("token")).toBe("secret-token");
		expect(url.origin + url.pathname).toBe("https://example.com/exec");
	});

	test("既存クエリを持つ endpoint でも token を追加する", async () => {
		let capturedUrl: string | undefined;
		globalThis.fetch = mock((input: string) => {
			capturedUrl = input;
			return Promise.resolve({
				ok: true,
				status: 200,
				json: () => Promise.resolve(makeResult()),
				text: () => Promise.resolve(""),
			} as Response);
		}) as unknown as typeof globalThis.fetch;

		await fetchNewEmails("https://example.com/exec?foo=bar", "tok");

		const url = new URL(capturedUrl as string);
		expect(url.searchParams.get("foo")).toBe("bar");
		expect(url.searchParams.get("token")).toBe("tok");
	});

	test("token が既存の同名クエリを上書きする（searchParams.set の挙動）", async () => {
		let capturedUrl: string | undefined;
		globalThis.fetch = mock((input: string) => {
			capturedUrl = input;
			return Promise.resolve({
				ok: true,
				status: 200,
				json: () => Promise.resolve(makeResult()),
				text: () => Promise.resolve(""),
			} as Response);
		}) as unknown as typeof globalThis.fetch;

		await fetchNewEmails("https://example.com/exec?token=old", "new-token");

		const url = new URL(capturedUrl as string);
		expect(url.searchParams.getAll("token")).toEqual(["new-token"]);
	});

	test("レスポンスの JSON を EmailCheckResult として返す", async () => {
		const payload = makeResult({ count: 3 });
		globalThis.fetch = mock(() =>
			Promise.resolve({
				ok: true,
				status: 200,
				json: () => Promise.resolve(payload),
				text: () => Promise.resolve(""),
			} as Response),
		) as unknown as typeof globalThis.fetch;

		const result = await fetchNewEmails("https://example.com/exec", "tok");

		expect(result).toEqual(payload);
	});

	test("非 2xx レスポンスで status と body を含むエラーを throw する", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve({
				ok: false,
				status: 503,
				json: () => Promise.resolve({}),
				text: () => Promise.resolve("service unavailable"),
			} as Response),
		) as unknown as typeof globalThis.fetch;

		await expect(fetchNewEmails("https://example.com/exec", "tok")).rejects.toThrow(
			"Email check failed: 503 service unavailable",
		);
	});

	test("非 2xx の場合は json をパースしない", async () => {
		const jsonSpy = mock(() => Promise.resolve({}));
		globalThis.fetch = mock(() =>
			Promise.resolve({
				ok: false,
				status: 401,
				json: jsonSpy,
				text: () => Promise.resolve("unauthorized"),
			} as unknown as Response),
		) as unknown as typeof globalThis.fetch;

		await expect(fetchNewEmails("https://example.com/exec", "tok")).rejects.toThrow();
		expect(jsonSpy).not.toHaveBeenCalled();
	});
});

describe("formatEmailContext bodyExcerpt トランケート境界値", () => {
	function formatBody(body: string): string {
		return formatEmailContext(
			makeResult({
				emails: [
					{ subject: "s", from: "f@example.com", date: "2026-06-10T09:00:00Z", bodyExcerpt: body },
				],
			}),
		);
	}

	test("199 文字はそのまま含まれる", () => {
		const body = "x".repeat(199);
		const output = formatBody(body);
		expect(output).toContain(body);
	});

	test("ちょうど 200 文字はそのまま含まれる", () => {
		const body = "x".repeat(200);
		const output = formatBody(body);
		expect(output).toContain(body);
	});

	test("201 文字は 200 文字に切り詰められる（201 文字目は含まれない）", () => {
		// 本文末尾のマーカー文字。date 等の他フィールドに出ない文字を選ぶ
		const body = "x".repeat(200) + "あ";
		const output = formatBody(body);
		expect(output).toContain("x".repeat(200));
		expect(output).not.toContain("あ");
	});
});

describe("formatEmailContext 内部フォーマット詳細", () => {
	test("複数メールは 1 始まりの連番で列挙する", () => {
		const output = formatEmailContext(
			makeResult({
				count: 3,
				emails: [
					{ subject: "一", from: "a@e.com", date: "d1", bodyExcerpt: "b1" },
					{ subject: "二", from: "b@e.com", date: "d2", bodyExcerpt: "b2" },
					{ subject: "三", from: "c@e.com", date: "d3", bodyExcerpt: "b3" },
				],
			}),
		);

		expect(output).toContain("1. 「一」from a@e.com (d1)");
		expect(output).toContain("2. 「二」from b@e.com (d2)");
		expect(output).toContain("3. 「三」from c@e.com (d3)");
	});

	test("件数は emails.length ではなく count フィールドを使う", () => {
		// count と emails.length が不一致でも count の値が出力される
		const output = formatEmailContext(
			makeResult({
				count: 99,
				emails: [{ subject: "s", from: "f@e.com", date: "d", bodyExcerpt: "b" }],
			}),
		);

		expect(output).toContain("新着メール 99 件:");
	});

	test("本文抜粋は件名行の次行にインデント付きで配置される", () => {
		const output = formatEmailContext(
			makeResult({
				count: 1,
				emails: [{ subject: "件名", from: "f@e.com", date: "d", bodyExcerpt: "本文" }],
			}),
		);

		expect(output).toContain("1. 「件名」from f@e.com (d)\n   本文");
	});
});
