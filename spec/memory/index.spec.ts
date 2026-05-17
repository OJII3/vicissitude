/* oxlint-disable require-await -- test mock */
import { describe, expect, test } from "bun:test";

import { createMemory } from "@vicissitude/memory";
import type { MemoryCommandServices, MemoryReadServices } from "@vicissitude/memory";
import type { MemoryLlmPort } from "@vicissitude/memory/llm-port";
import { MemoryStorage } from "@vicissitude/memory/storage";

const mockLLM: MemoryLlmPort = {
	chat: async () => "mock",
	chatStructured: async <T>(_msgs: unknown[], schema: { parse: (d: unknown) => T }) =>
		schema.parse({}),
	embed: async () => [0.1],
};

describe("createMemory", () => {
	test("returns object with all services", () => {
		const storage = new MemoryStorage(":memory:");
		const f = createMemory({ llm: mockLLM, storage });
		expect(f.segmenter).toBeDefined();
		expect(f.episodic).toBeDefined();
		expect(f.consolidation).toBeDefined();
		expect(f.retrieval).toBeDefined();
		expect(f.retrievalReview).toBeDefined();
		storage.close();
	});

	test("publishes purpose-specific read and command ports", () => {
		const storage = new MemoryStorage(":memory:");
		const f = createMemory({ llm: mockLLM, storage });

		const read: MemoryReadServices = f.read;
		const commands: MemoryCommandServices = f.commands;

		expect(read.retrieval).toBe(f.retrieval);
		expect(read.semantic).toBe(f.semantic);
		expect(commands.retrievalReview).toBe(f.retrievalReview);
		expect(commands.segmenter).toBe(f.segmenter);
		storage.close();
	});
});
