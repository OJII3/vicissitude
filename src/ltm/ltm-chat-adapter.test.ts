import { describe, expect, it, mock } from "bun:test";

import type { OpencodeSessionPort } from "../core/types.ts";
import {
	LtmChatAdapter,
	appendJsonInstruction,
	cleanJsonResponse,
	separateMessages,
} from "./ltm-chat-adapter.ts";
import type { ChatMessage } from "./types.ts";

function createMockSessionPort(promptResults: { text: string }[]): OpencodeSessionPort {
	let callIndex = 0;
	return {
		createSession: mock(() => Promise.resolve("test-session-id")),
		sessionExists: mock(() => Promise.resolve(true)),
		prompt: mock(() => {
			const result = promptResults[callIndex];
			callIndex++;
			if (!result) throw new Error("No more prompt results configured");
			return Promise.resolve(result);
		}),
		promptAsync: mock(() => Promise.resolve()),
		promptAsyncAndWatchSession: mock(() =>
			Promise.resolve({ type: "idle" as const, messages: [] }),
		),
		waitForSessionIdle: mock(() => Promise.resolve({ type: "idle" as const, messages: [] })),
		deleteSession: mock(() => Promise.resolve()),
		close: mock(() => {}),
	} as unknown as OpencodeSessionPort;
}

const validSchema = {
	parse: (data: unknown) => data as { key: string },
};

describe("chatStructured", () => {
	const messages: ChatMessage[] = [{ role: "user", content: "Give me JSON" }];

	it("should return parsed result when LLM returns valid JSON on first attempt", async () => {
		const port = createMockSessionPort([{ text: '{"key": "value"}' }]);
		const adapter = new LtmChatAdapter(port, "provider", "model");

		const result = await adapter.chatStructured(messages, validSchema);

		expect(result).toEqual({ key: "value" });
	});

	it("should retry when LLM returns empty string, and succeed on second attempt", async () => {
		const port = createMockSessionPort([{ text: "" }, { text: '{"key": "retried"}' }]);
		const adapter = new LtmChatAdapter(port, "provider", "model");

		const result = await adapter.chatStructured(messages, validSchema);

		expect(result).toEqual({ key: "retried" });
		expect(port.prompt).toHaveBeenCalledTimes(2);
	});

	it("should throw a clear error when retry limit is exceeded with empty responses", async () => {
		const port = createMockSessionPort([{ text: "" }, { text: "" }, { text: "" }]);
		const adapter = new LtmChatAdapter(port, "provider", "model");

		await expect(adapter.chatStructured(messages, validSchema)).rejects.toThrow(
			/empty.*response|retry/i,
		);
	});
});

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
