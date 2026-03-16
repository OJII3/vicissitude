import { describe, expect, test } from "bun:test";

import { rewriteTwitterUrls } from "../../../src/infrastructure/discord/url-rewriter.ts";

describe("rewriteTwitterUrls", () => {
	test("x.com URL を fxtwitter.com に置換する", () => {
		expect(rewriteTwitterUrls("https://x.com/user/status/123")).toBe(
			"https://fxtwitter.com/user/status/123",
		);
	});

	test("twitter.com URL を fxtwitter.com に置換する", () => {
		expect(rewriteTwitterUrls("https://twitter.com/user/status/456")).toBe(
			"https://fxtwitter.com/user/status/456",
		);
	});

	test("複数の URL を一括置換する", () => {
		const input = "見て https://x.com/a/status/1 と https://twitter.com/b/status/2";
		const expected = "見て https://fxtwitter.com/a/status/1 と https://fxtwitter.com/b/status/2";
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
});
