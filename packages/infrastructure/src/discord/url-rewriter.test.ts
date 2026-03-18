import { describe, expect, test } from "bun:test";

import { rewriteTwitterUrls } from "./url-rewriter.ts";

describe("rewriteTwitterUrls — 境界条件", () => {
	test("www 付き x.com を置換する", () => {
		expect(rewriteTwitterUrls("https://www.x.com/user/status/1")).toBe(
			"https://fxtwitter.com/user/status/1",
		);
	});

	test("www 付き twitter.com を置換する", () => {
		expect(rewriteTwitterUrls("https://www.twitter.com/user/status/1")).toBe(
			"https://fxtwitter.com/user/status/1",
		);
	});

	test("http (非 TLS) も置換する", () => {
		expect(rewriteTwitterUrls("http://x.com/user/status/1")).toBe(
			"https://fxtwitter.com/user/status/1",
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

	test("パスなしの URL も置換する", () => {
		expect(rewriteTwitterUrls("https://x.com/")).toBe("https://fxtwitter.com/");
	});

	test("mobile.x.com を置換する", () => {
		expect(rewriteTwitterUrls("https://mobile.x.com/user/status/1")).toBe(
			"https://fxtwitter.com/user/status/1",
		);
	});

	test("mobile.twitter.com を置換する", () => {
		expect(rewriteTwitterUrls("https://mobile.twitter.com/user/status/1")).toBe(
			"https://fxtwitter.com/user/status/1",
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
		const input = "https://x.com/a/1 `https://x.com/b/2` https://x.com/c/3";
		const expected = "https://fxtwitter.com/a/1 `https://x.com/b/2` https://fxtwitter.com/c/3";
		expect(rewriteTwitterUrls(input)).toBe(expected);
	});
});
