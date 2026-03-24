import { describe, expect, mock, test } from "bun:test";

import type { AppConfig } from "@vicissitude/shared/config";

import { createStoreLayer, createMetrics } from "./bootstrap.ts";

function createTestConfig(overrides?: Partial<AppConfig>): AppConfig {
	return {
		discordToken: "test-token",
		webPort: 4000,
		gatewayPort: 4001,
		opencode: {
			providerId: "test-provider",
			modelId: "test-model",
			basePort: 4096,
			sessionMaxAgeHours: 48,
		},
		coreMcpPort: 4095,
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
