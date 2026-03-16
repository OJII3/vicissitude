/* oxlint-disable require-await -- test mock */
import { describe, expect, test } from "bun:test";

import { createLtm } from "../../packages/ltm/src/index.ts";
import type { LtmLlmPort } from "../../packages/ltm/src/llm-port.ts";
import { LtmStorage } from "../../packages/ltm/src/ltm-storage.ts";

const mockLLM: LtmLlmPort = {
	chat: async () => "mock",
	chatStructured: async <T>(_msgs: unknown[], schema: { parse: (d: unknown) => T }) =>
		schema.parse({}),
	embed: async () => [0.1],
};

describe("createLtm", () => {
	test("returns object with all services", () => {
		const storage = new LtmStorage(":memory:");
		const f = createLtm({ llm: mockLLM, storage });
		expect(f.segmenter).toBeDefined();
		expect(f.episodic).toBeDefined();
		expect(f.consolidation).toBeDefined();
		expect(f.retrieval).toBeDefined();
		storage.close();
	});
});
