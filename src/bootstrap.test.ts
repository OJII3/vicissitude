import { describe, expect, mock, test } from "bun:test";

import { createStoreLayer, createMetrics } from "./bootstrap.ts";
import type { AppConfig } from "./core/config.ts";

function createTestConfig(overrides?: Partial<AppConfig>): AppConfig {
	return {
		discordToken: "test-token",
		opencode: {
			providerId: "test-provider",
			modelId: "test-model",
			basePort: 4096,
			sessionMaxAgeHours: 48,
		},
		coreMcpPort: 4095,
		ltm: {
			providerId: "test-provider",
			modelId: "test-model",
			ollamaBaseUrl: "http://localhost:11434",
			embeddingModel: "test-embedding",
		},
		mcSubBrain: {
			providerId: "test-provider",
			modelId: "test-model",
		},
		dataDir: ":memory:",
		contextDir: "/tmp/test-context",
		...overrides,
	};
}

describe("createStoreLayer", () => {
	test("DB と SessionStore を返す", () => {
		const config = createTestConfig();
		const { db, sessionStore } = createStoreLayer(config);

		expect(db).toBeDefined();
		expect(sessionStore.count()).toBe(0);
	});
});

describe("createMetrics", () => {
	test("collector と server を返す", () => {
		const logger = {
			info: mock(() => {}),
			warn: mock(() => {}),
			error: mock(() => {}),
		};
		const { collector, server } = createMetrics(logger);

		expect(collector).toBeDefined();
		expect(server).toBeDefined();
	});
});
