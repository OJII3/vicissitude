/* oxlint-disable require-await -- test mock */
import { describe, expect, test } from "bun:test";

import { createMemory } from "@vicissitude/memory";
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
		storage.close();
	});
});
