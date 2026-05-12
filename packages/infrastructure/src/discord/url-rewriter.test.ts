import { describe, expect, test } from "bun:test";

import { rewriteTwitterUrls } from "./url-rewriter.ts";

describe("rewriteTwitterUrls — 境界条件", () => {
	test("www 付き x.com の status URL を FxEmbed API URL に置換する", () => {
		expect(rewriteTwitterUrls("https://www.x.com/user/status/123")).toBe(
			"https://api.fxtwitter.com/2/status/123",
		);
	});

	test("www 付き twitter.com の status URL を FxEmbed API URL に置換する", () => {
		expect(rewriteTwitterUrls("https://www.twitter.com/user/status/123")).toBe(
			"https://api.fxtwitter.com/2/status/123",
		);
	});

	test("http (非 TLS) の status URL も FxEmbed API URL に置換する", () => {
		expect(rewriteTwitterUrls("http://x.com/user/status/123")).toBe(
			"https://api.fxtwitter.com/2/status/123",
		);
	});

	test("fxtwitter.com は二重置換しない", () => {
		const input = "https://fxtwitter.com/user/status/1";
		expect(rewriteTwitterUrls(input)).toBe(input);
	});

	test("部分一致しない (notx.com)", () => {
		const input = "https://notx.com/path";
		expect(rewriteTwitterUrls(input)).toBe(input);
	});

	test("部分一致しない (mytwitter.com)", () => {
		const input = "https://mytwitter.com/path";
		expect(rewriteTwitterUrls(input)).toBe(input);
	});

	test("status ではない x.com URL は fixupx.com に置換する", () => {
		expect(rewriteTwitterUrls("https://x.com/user")).toBe("https://fixupx.com/user");
	});

	test("status ではない twitter.com URL は fxtwitter.com に置換する", () => {
		expect(rewriteTwitterUrls("https://twitter.com/user")).toBe("https://fxtwitter.com/user");
	});

	test("mobile.x.com の status URL を FxEmbed API URL に置換する", () => {
		expect(rewriteTwitterUrls("https://mobile.x.com/user/status/123")).toBe(
			"https://api.fxtwitter.com/2/status/123",
		);
	});

	test("mobile.twitter.com の status URL を FxEmbed API URL に置換する", () => {
		expect(rewriteTwitterUrls("https://mobile.twitter.com/user/status/123")).toBe(
			"https://api.fxtwitter.com/2/status/123",
		);
	});

	test("インラインコード内の URL は置換しない", () => {
		const input = "見て `https://x.com/user/status/1` これ";
		expect(rewriteTwitterUrls(input)).toBe(input);
	});

	test("コードブロック内の URL は置換しない", () => {
		const input = "```\nhttps://x.com/user/status/1\n```";
		expect(rewriteTwitterUrls(input)).toBe(input);
	});

	test("コードブロック外の URL は置換しつつコードブロック内は保持する", () => {
		const input =
			"https://x.com/a/status/123 `https://x.com/b/status/456` https://x.com/c/status/789";
		const expected =
			"https://api.fxtwitter.com/2/status/123 `https://x.com/b/status/456` https://api.fxtwitter.com/2/status/789";
		expect(rewriteTwitterUrls(input)).toBe(expected);
	});

	test("status URL のクエリは API URL では取り除く", () => {
		expect(rewriteTwitterUrls("https://x.com/user/status/123?s=20")).toBe(
			"https://api.fxtwitter.com/2/status/123",
		);
	});

	test("URL 直後の句読点は置換後も保持する", () => {
		expect(rewriteTwitterUrls("見て https://x.com/user/status/123.")).toBe(
			"見て https://api.fxtwitter.com/2/status/123.",
		);
	});
});
