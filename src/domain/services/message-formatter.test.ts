import { describe, expect, it } from "bun:test";

import { splitMessage } from "./message-formatter.ts";

describe("splitMessage", () => {
	it("短いメッセージはそのまま返る", () => {
		const result = splitMessage("hello");
		expect(result).toEqual(["hello"]);
	});

	it("maxLength 以下のメッセージは分割されない", () => {
		const text = "a".repeat(2000);
		const result = splitMessage(text);
		expect(result).toEqual([text]);
	});

	it("maxLength 超のメッセージが分割される", () => {
		const text = "a".repeat(3000);
		const result = splitMessage(text, 2000);
		expect(result.length).toBe(2);
		expect(result[0]).toBe("a".repeat(2000));
		expect(result[1]).toBe("a".repeat(1000));
	});

	it("改行位置で分割される", () => {
		const line = "a".repeat(50);
		const text = `${line}\n${line}\n${line}`;
		const result = splitMessage(text, 55);
		expect(result).toEqual([line, line, line]);
	});

	it("改行文字が次チャンクの先頭に残らない", () => {
		const text = "aaa\nbbb";
		const result = splitMessage(text, 5);
		expect(result[0]).toBe("aaa");
		expect(result[1]).toBe("bbb");
	});

	it("カスタム maxLength を指定できる", () => {
		const text = "a".repeat(20);
		const result = splitMessage(text, 10);
		expect(result).toEqual(["a".repeat(10), "a".repeat(10)]);
	});
});
