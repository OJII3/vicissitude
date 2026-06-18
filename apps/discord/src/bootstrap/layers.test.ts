import { describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import os from "os";
import { join } from "path";

import type { AppConfig } from "../config.ts";
import { createContextLayer, createStoreLayer, createWebContextLayer } from "./layers.ts";

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
		heartbeatOpencode: {
			providerId: "test-heartbeat-provider",
			modelId: "test-heartbeat-model",
			temperature: 0.3,
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
	writeFileSync(join(contextDir, "TOOLS-DISCORD.md"), "discord tools");
	writeFileSync(join(contextDir, "TOOLS-CORE.md"), "core tools");
	writeFileSync(join(contextDir, "TOOLS-CODE.md"), "shell tools");
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

describe("createContextLayer", () => {
	test("デフォルトでは capability 連動ツール説明を除外する", async () => {
		const root = createContextRoot();
		const { contextBuilder } = createContextLayer(createTestConfig(), root);
		const context = await contextBuilder.build();

		expect(context).toContain("core tools");
		expect(context).toContain("discord tools");
		expect(context).not.toContain("shell tools");
		expect(context).not.toContain("minecraft tools");
	});

	test("shellWorkspace 有効時も TOOLS-CODE は直接注入しない", async () => {
		const root = createContextRoot();
		const { contextBuilder } = createContextLayer(
			createTestConfig({
				shellAgent: {
					enabled: true,
					agent: {
						providerId: "shell-provider",
						modelId: "shell-model",
					},
					dataDir: "/tmp/shell-workspaces",
				},
			}),
			root,
		);
		const context = await contextBuilder.build();

		expect(context).toContain("core tools");
		expect(context).toContain("discord tools");
		expect(context).not.toContain("shell tools");
		expect(context).not.toContain("<TOOLS-CODE.md>");
		expect(context).not.toContain("minecraft tools");
	});

	test("Minecraft 有効時も TOOLS-MINECRAFT は直接注入しない", async () => {
		const root = createContextRoot();
		const contextDir = join(root, "context");
		writeFileSync(join(contextDir, "TOOLS-MINECRAFT.md"), "minecraft tools");
		const { contextBuilder } = createContextLayer(
			createTestConfig({
				minecraft: {
					host: "localhost",
					port: 25565,
					username: "hua",
					authMode: "offline",
					mcpPort: 3001,
					viewerPort: 3007,
				},
			}),
			root,
		);
		const context = await contextBuilder.build();

		expect(context).toContain("core tools");
		expect(context).toContain("discord tools");
		expect(context).not.toContain("minecraft tools");
		expect(context).not.toContain("<TOOLS-MINECRAFT.md>");
	});

	test("Web context は人格と core tools を残し Discord 固有コンテキストを除外する", async () => {
		const root = createContextRoot();
		const contextDir = join(root, "context");
		writeFileSync(join(contextDir, "IDENTITY.md"), "identity");
		writeFileSync(join(contextDir, "DISCORD.md"), "discord rules");
		writeFileSync(join(contextDir, "HEARTBEAT.md"), "heartbeat rules");
		const { contextBuilder } = createWebContextLayer(createTestConfig(), root);
		const context = await contextBuilder.build("web:local");

		expect(context).toContain("identity");
		expect(context).toContain("core tools");
		expect(context).not.toContain("discord rules");
		expect(context).not.toContain("heartbeat rules");
		expect(context).not.toContain("discord tools");
		expect(context).not.toContain("shell tools");
		expect(context).not.toContain("minecraft tools");
	});
});
