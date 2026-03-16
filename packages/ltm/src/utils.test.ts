import { describe, expect, test } from "bun:test";

import { escapeXmlContent, validateUserId } from "./utils.ts";

describe("escapeXmlContent", () => {
	test("escapes ampersands", () => {
		expect(escapeXmlContent("a & b")).toBe("a &amp; b");
	});

	test("escapes less-than", () => {
		expect(escapeXmlContent("a < b")).toBe("a &lt; b");
	});

	test("escapes greater-than", () => {
		expect(escapeXmlContent("a > b")).toBe("a &gt; b");
	});

	test("escapes all XML-special characters together", () => {
		expect(escapeXmlContent("<script>alert('xss')</script>")).toBe(
			"&lt;script&gt;alert('xss')&lt;/script&gt;",
		);
	});

	test("escapes closing conversation tag (injection vector)", () => {
		expect(escapeXmlContent("</conversation>")).toBe("&lt;/conversation&gt;");
	});

	test("leaves safe content unchanged", () => {
		expect(escapeXmlContent("Hello, world!")).toBe("Hello, world!");
	});

	test("handles empty string", () => {
		expect(escapeXmlContent("")).toBe("");
	});

	test("handles ampersand before angle bracket", () => {
		expect(escapeXmlContent("&<")).toBe("&amp;&lt;");
	});
});

describe("validateUserId", () => {
	test("throws on empty string", () => {
		expect(() => validateUserId("")).toThrow("userId must not be empty");
	});

	test("throws on string exceeding 256 characters", () => {
		const longId = "a".repeat(257);
		expect(() => validateUserId(longId)).toThrow("userId too long");
	});

	test("accepts valid userId", () => {
		expect(() => validateUserId("user-123")).not.toThrow();
	});

	test("accepts userId at max length boundary", () => {
		const maxId = "a".repeat(256);
		expect(() => validateUserId(maxId)).not.toThrow();
	});
});
