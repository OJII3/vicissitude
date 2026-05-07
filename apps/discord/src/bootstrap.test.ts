import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import os from "os";
import { join } from "path";

import { createMockLogger } from "@vicissitude/shared/test-helpers";

import { createContextLayer, createStoreLayer, createMetrics } from "./bootstrap.ts";
import type { AppConfig } from "./config.ts";

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
			temperature: 1.0,
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
			temperature: 0.7,
		},
		dataDir: "/tmp/vicissitude-bootstrap-test",
		contextDir: "/tmp/test-context",
		...overrides,
	};
}

function createContextRoot(): string {
	const root = mkdtempSync(join(os.tmpdir(), "vicissitude-context-root-"));
	const contextDir = join(root, "context");
	mkdirSync(contextDir, { recursive: true });
	writeFileSync(join(contextDir, "TOOLS-CORE.md"), "core tools");
	writeFileSync(join(contextDir, "TOOLS-CODE.md"), "shell tools");
	writeFileSync(join(contextDir, "TOOLS-MINECRAFT.md"), "minecraft tools");
	return root;
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

describe("createContextLayer", () => {
	test("デフォルトでは capability 連動ツール説明を除外する", async () => {
		const root = createContextRoot();
		const { contextBuilder } = createContextLayer(createTestConfig(), root);
		const context = await contextBuilder.build();

		expect(context).toContain("core tools");
		expect(context).not.toContain("shell tools");
		expect(context).not.toContain("minecraft tools");
	});

	test("shellWorkspace 有効時は TOOLS-CODE を注入する", async () => {
		const root = createContextRoot();
		const { contextBuilder } = createContextLayer(
			createTestConfig({
				shellWorkspace: {
					enabled: true,
					image: "sandbox",
					agent: {
						providerId: "shell-provider",
						modelId: "shell-model",
						temperature: 0.4,
						steps: 16,
					},
					dataDir: "/tmp/shell-workspaces",
					auditLogPath: "/tmp/shell-audit.jsonl",
					networkProfile: "open",
					defaultTtlMinutes: 60,
					maxTtlMinutes: 120,
					defaultTimeoutSeconds: 30,
					maxTimeoutSeconds: 120,
					maxOutputChars: 50_000,
				},
			}),
			root,
		);
		const context = await contextBuilder.build();

		expect(context).toContain("core tools");
		expect(context).toContain("shell tools");
		expect(context).not.toContain("minecraft tools");
	});
});
