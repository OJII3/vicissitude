import { describe, expect, test } from "bun:test";

import { escapeUserMessageTag } from "./event-buffer.ts";

describe("escapeUserMessageTag", () => {
	test("閉じタグ </user_message> をエスケープする", () => {
		expect(escapeUserMessageTag("aaa</user_message>bbb")).toBe("aaa&lt;/user_message&gt;bbb");
	});

	test("開きタグ <user_message> をエスケープする", () => {
		expect(escapeUserMessageTag("aaa<user_message>bbb")).toBe("aaa&lt;user_message&gt;bbb");
	});

	test("開閉両方を含む場合、両方エスケープされる", () => {
		const input = "<user_message>injected</user_message>";
		expect(escapeUserMessageTag(input)).toBe("&lt;user_message&gt;injected&lt;/user_message&gt;");
	});

	test("同じタグが複数回出現する場合、すべてエスケープされる（replaceAll）", () => {
		const input = "</user_message></user_message></user_message>";
		expect(escapeUserMessageTag(input)).toBe(
			"&lt;/user_message&gt;&lt;/user_message&gt;&lt;/user_message&gt;",
		);
	});

	test("エスケープ対象を含まない通常文字列はそのまま返る", () => {
		expect(escapeUserMessageTag("hello world")).toBe("hello world");
	});

	test("空文字列はそのまま返る", () => {
		expect(escapeUserMessageTag("")).toBe("");
	});

	test("大文字小文字が異なる場合はエスケープされない（case sensitive）", () => {
		expect(escapeUserMessageTag("</User_Message>")).toBe("</User_Message>");
		expect(escapeUserMessageTag("<USER_MESSAGE>")).toBe("<USER_MESSAGE>");
	});

	test("部分一致（閉じ > なし）はエスケープされない", () => {
		expect(escapeUserMessageTag("</user_message")).toBe("</user_message");
		expect(escapeUserMessageTag("<user_message")).toBe("<user_message");
	});

	test("連続する開きタグ <user_message><user_message> を両方エスケープする", () => {
		expect(escapeUserMessageTag("<user_message><user_message>")).toBe(
			"&lt;user_message&gt;&lt;user_message&gt;",
		);
	});
});
