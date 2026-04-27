import { describe, expect, test } from "bun:test";

import { createMockLogger } from "@vicissitude/shared/test-helpers";

import { createStoreLayer, createMetrics } from "./bootstrap.ts";
import type { AppConfig } from "./config.ts";

function createTestConfig(overrides?: Partial<AppConfig>): AppConfig {
	return {
		botName: "ふあ",
		discordToken: "test-token",
		webPort: 4000,
		gatewayPort: 4001,
		opencode: {
			providerId: "test-provider",
			modelId: "test-model",
			basePort: 4096,
			sessionMaxAgeHours: 48,
		},
		memory: {
			providerId: "test-provider",
			modelId: "test-model",
			ollamaBaseUrl: "http://localhost:11434",
			embeddingModel: "test-embedding",
		},
		mcBrain: {
			providerId: "test-provider",
			modelId: "test-model",
		},
		dataDir: "/tmp/vicissitude-bootstrap-test",
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
		const logger = createMockLogger();
		const { collector, server } = createMetrics(logger, 0);

		expect(collector).toBeDefined();
		expect(server).toBeDefined();
	});
});
