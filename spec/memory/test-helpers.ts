/* oxlint-disable require-await -- mock implementations */
import type { Episode } from "@vicissitude/memory/episode";
import { createEpisode } from "@vicissitude/memory/episode";
import type { MemoryLlmPort, Schema } from "@vicissitude/memory/llm-port";
import { createFact } from "@vicissitude/memory/semantic-fact";
import type { ChatMessage } from "@vicissitude/memory/types";

const defaultUserId = "user-1";

export function makeEpisode(overrides: Partial<Parameters<typeof createEpisode>[0]> = {}): Episode {
	return createEpisode({
		userId: defaultUserId,
		title: "Test Episode",
		summary: "A summary",
		messages: [{ role: "user", content: "hello" }] as ChatMessage[],
		embedding: [0.1, 0.2, 0.3],
		surprise: 0.5,
		startAt: new Date("2026-01-01T00:00:00Z"),
		endAt: new Date("2026-01-01T01:00:00Z"),
		...overrides,
	});
}

export function makeFact(overrides: Partial<Parameters<typeof createFact>[0]> = {}) {
	return createFact({
		userId: defaultUserId,
		category: "preference",
		fact: "Likes TypeScript",
		keywords: ["typescript"],
		sourceEpisodicIds: ["ep-1"],
		embedding: [0.1, 0.2, 0.3],
		...overrides,
	});
}

export interface MockLLMOptions {
	structuredResponse?: unknown;
	embedding?: number[];
}

export function createMockLLM(opts: MockLLMOptions = {}): MemoryLlmPort {
	const { structuredResponse, embedding = [0.1, 0.2, 0.3] } = opts;
	return {
		chat: async () => "mock response",
		chatStructured: async <T>(_: ChatMessage[], schema: Schema<T>) =>
			schema.parse(structuredResponse ?? {}),
		embed: async () => embedding,
	};
}

export function createInvalidLLM(invalidResponse: unknown): MemoryLlmPort {
	return {
		chat: async () => "",
		chatStructured: async <T>(_: ChatMessage[], schema: Schema<T>) => schema.parse(invalidResponse),
		embed: async () => [0.1, 0.2],
	};
}

export function makeMessage(content: string, role: ChatMessage["role"] = "user"): ChatMessage {
	return { role, content, timestamp: new Date() };
}

export function makeMessages(count: number): ChatMessage[] {
	return Array.from({ length: count }, (_, i) =>
		makeMessage(`message ${i}`, i % 2 === 0 ? "user" : "assistant"),
	);
}
