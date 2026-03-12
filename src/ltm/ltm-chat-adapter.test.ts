import { describe, expect, it } from "bun:test";

import { appendJsonInstruction, cleanJsonResponse, separateMessages } from "./ltm-chat-adapter.ts";
import type { ChatMessage } from "./types.ts";

describe("separateMessages", () => {
	it("should separate system messages from non-system messages", () => {
		const messages: ChatMessage[] = [
			{ role: "system", content: "You are helpful" },
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: "Hi there" },
		];

		const result = separateMessages(messages);

		expect(result.system).toBe("You are helpful");
		expect(result.userContent).toBe("user: Hello\nassistant: Hi there");
	});

	it("should join multiple system messages with double newlines", () => {
		const messages: ChatMessage[] = [
			{ role: "system", content: "Rule 1" },
			{ role: "system", content: "Rule 2" },
			{ role: "user", content: "Hello" },
		];

		const result = separateMessages(messages);

		expect(result.system).toBe("Rule 1\n\nRule 2");
		expect(result.userContent).toBe("user: Hello");
	});

	it("should return undefined system when no system messages exist", () => {
		const messages: ChatMessage[] = [
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: "Hi" },
		];

		const result = separateMessages(messages);

		expect(result.system).toBeUndefined();
		expect(result.userContent).toBe("user: Hello\nassistant: Hi");
	});

	it("should handle empty messages array", () => {
		const result = separateMessages([]);

		expect(result.system).toBeUndefined();
		expect(result.userContent).toBe("");
	});

	it("should handle only system messages", () => {
		const messages: ChatMessage[] = [{ role: "system", content: "System only" }];

		const result = separateMessages(messages);

		expect(result.system).toBe("System only");
		expect(result.userContent).toBe("");
	});
});

describe("appendJsonInstruction", () => {
	it("should append JSON instruction to the last user message", () => {
		const messages: ChatMessage[] = [
			{ role: "system", content: "Be helpful" },
			{ role: "user", content: "Give me data" },
		];

		const result = appendJsonInstruction(messages);

		expect(result).toHaveLength(2);
		expect(result[0]?.content).toBe("Be helpful");
		expect(result[1]?.content).toContain("Give me data");
		expect(result[1]?.content).toContain("IMPORTANT: Respond ONLY with valid JSON");
	});

	it("should not modify original messages array", () => {
		const messages: ChatMessage[] = [{ role: "user", content: "Hello" }];
		const original = messages[0]?.content;

		appendJsonInstruction(messages);

		expect(messages[0]?.content).toBe(original);
	});

	it("should not append if last message is not from user", () => {
		const messages: ChatMessage[] = [
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: "Hi" },
		];

		const result = appendJsonInstruction(messages);

		expect(result[1]?.content).toBe("Hi");
	});

	it("should handle empty messages array", () => {
		const result = appendJsonInstruction([]);
		expect(result).toHaveLength(0);
	});
});

describe("cleanJsonResponse", () => {
	it("should return trimmed text when no code fences", () => {
		expect(cleanJsonResponse('  {"key": "value"}  ')).toBe('{"key": "value"}');
	});

	it("should strip json code fences", () => {
		const input = '```json\n{"key": "value"}\n```';
		expect(cleanJsonResponse(input)).toBe('{"key": "value"}');
	});

	it("should strip plain code fences", () => {
		const input = '```\n{"key": "value"}\n```';
		expect(cleanJsonResponse(input)).toBe('{"key": "value"}');
	});

	it("should handle code fences with surrounding whitespace", () => {
		const input = '  ```json\n{"key": "value"}\n```  ';
		expect(cleanJsonResponse(input)).toBe('{"key": "value"}');
	});

	it("should handle multiline JSON inside fences", () => {
		const input = '```json\n{\n  "a": 1,\n  "b": 2\n}\n```';
		expect(cleanJsonResponse(input)).toBe('{\n  "a": 1,\n  "b": 2\n}');
	});

	it("should return plain JSON as-is", () => {
		const input = '{"simple": true}';
		expect(cleanJsonResponse(input)).toBe('{"simple": true}');
	});
});
