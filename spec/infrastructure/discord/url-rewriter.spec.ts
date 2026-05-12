import { describe, expect, test } from "bun:test";

import { rewriteTwitterUrls } from "@vicissitude/infrastructure/discord/url-rewriter";

describe("rewriteTwitterUrls", () => {
	test("x.com の status URL を FxEmbed API URL に置換する", () => {
		expect(rewriteTwitterUrls("https://x.com/user/status/123")).toBe(
			"https://api.fxtwitter.com/2/status/123",
		);
	});

	test("twitter.com の status URL を FxEmbed API URL に置換する", () => {
		expect(rewriteTwitterUrls("https://twitter.com/user/status/456")).toBe(
			"https://api.fxtwitter.com/2/status/456",
		);
	});

	test("複数の status URL を一括置換する", () => {
		const input = "見て https://x.com/a/status/1 と https://twitter.com/b/status/2";
		const expected =
			"見て https://api.fxtwitter.com/2/status/1 と https://api.fxtwitter.com/2/status/2";
		expect(rewriteTwitterUrls(input)).toBe(expected);
	});

	test("Twitter 以外の URL は変更しない", () => {
		const input = "https://example.com/path https://github.com/repo";
		expect(rewriteTwitterUrls(input)).toBe(input);
	});

	test("URL を含まないテキストはそのまま返す", () => {
		expect(rewriteTwitterUrls("こんにちは")).toBe("こんにちは");
	});

	test("空文字列はそのまま返す", () => {
		expect(rewriteTwitterUrls("")).toBe("");
	});

	test("mobile.x.com の status URL を FxEmbed API URL に置換する", () => {
		expect(rewriteTwitterUrls("https://mobile.x.com/user/status/789")).toBe(
			"https://api.fxtwitter.com/2/status/789",
		);
	});

	test("mobile.twitter.com の status URL を FxEmbed API URL に置換する", () => {
		expect(rewriteTwitterUrls("https://mobile.twitter.com/user/status/101")).toBe(
			"https://api.fxtwitter.com/2/status/101",
		);
	});

	test("コードブロック内の URL は置換しない", () => {
		const input = "見て ```https://x.com/user/status/1``` これ";
		expect(rewriteTwitterUrls(input)).toBe(input);
	});

	test("インラインコード内の URL は置換しない", () => {
		const input = "`https://x.com/user/status/1`";
		expect(rewriteTwitterUrls(input)).toBe(input);
	});
});
