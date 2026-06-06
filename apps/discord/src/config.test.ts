import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";

import { loadConfig } from "./config.ts";

const BASE_PROFILE = {
	ports: {
		web: 4100,
		gateway: 4101,
		opencodeBase: 5000,
	},
	session: {
		maxAgeHours: 24,
	},
	models: {
		conversation: {
			providerId: "conversation-provider",
			modelId: "conversation-model",
			temperature: 0.8,
		},
		heartbeat: {
			providerId: "heartbeat-provider",
			modelId: "heartbeat-model",
			temperature: 0.3,
		},
		memory: {
			providerId: "memory-provider",
			modelId: "memory-model",
			ollamaBaseUrl: "http://localhost:11434",
			embeddingModel: "embedding-model",
		},
		minecraft: {
			providerId: "mc-provider",
			modelId: "mc-model",
			temperature: 0.4,
		},
	},
	features: {},
};

describe("loadConfig", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function writeProfileFile(profile: unknown): string {
		const dir = mkdtempSync(resolve(tmpdir(), "vicissitude-config-test-"));
		tempDirs.push(dir);
		const filepath = resolve(dir, "profile.json");
		writeFileSync(filepath, JSON.stringify(profile));
		return filepath;
	}

	function writeRootWithProfile(profile: unknown): { root: string; filepath: string } {
		const root = mkdtempSync(resolve(tmpdir(), "vicissitude-config-root-"));
		tempDirs.push(root);
		const filepath = resolve(root, "profile.json");
		writeFileSync(filepath, JSON.stringify(profile));
		return { root, filepath };
	}

	test("VICISSITUDE_CONFIG_PATH の JSON profile から設定を読み込む", () => {
		const filepath = writeProfileFile(BASE_PROFILE);
		const config = loadConfig(
			{
				VICISSITUDE_CONFIG_PATH: filepath,
				DISCORD_TOKEN: "test-token",
			},
			"/app",
		);

		expect(config.discordToken).toBe("test-token");
		expect(config.webPort).toBe(4100);
		expect(config.gatewayPort).toBe(4101);
		expect(config.opencode).toEqual({
			providerId: "conversation-provider",
			modelId: "conversation-model",
			basePort: 5000,
			sessionMaxAgeHours: 24,
			temperature: 0.8,
		});
		expect(config.heartbeatOpencode).toEqual({
			providerId: "heartbeat-provider",
			modelId: "heartbeat-model",
			temperature: 0.3,
		});
		expect(config.imageRecognition).toBeUndefined();
		expect(config.emotionEstimation).toBeUndefined();
		expect(config.dataDir).toBe("/app/data");
		expect(config.contextDir).toBe("/app/context");
	});

	test("VICISSITUDE_CONFIG_PATH 未指定ならエラーにする", () => {
		expect(() => loadConfig({ DISCORD_TOKEN: "test-token" }, "/app")).toThrow(
			"VICISSITUDE_CONFIG_PATH is required",
		);
	});

	test("profile の feature section だけを有効化する", () => {
		const filepath = writeProfileFile({
			...BASE_PROFILE,
			features: {
				imageRecognition: {
					providerId: "vision-provider",
					modelId: "vision-model",
				},
				emotionEstimation: {
					providerId: "openai",
					modelId: "gpt-5.4",
				},
			},
		});
		const config = loadConfig(
			{
				VICISSITUDE_CONFIG_PATH: filepath,
				DISCORD_TOKEN: "test-token",
			},
			"/app",
		);

		expect(config.imageRecognition).toEqual({
			enabled: true,
			providerId: "vision-provider",
			modelId: "vision-model",
		});
		expect(config.emotionEstimation).toEqual({
			enabled: true,
			providerId: "openai",
			modelId: "gpt-5.4",
			ollamaBaseUrl: undefined,
		});
	});

	test("data/context/runtime.json があれば discordDm を overlay する", () => {
		const { root, filepath } = writeRootWithProfile(BASE_PROFILE);
		const runtimeDir = resolve(root, "data/context");
		mkdirSync(runtimeDir, { recursive: true });
		writeFileSync(
			resolve(runtimeDir, "runtime.json"),
			JSON.stringify({
				discordDm: {
					allowedUserIds: ["883258849254072341"],
				},
			}),
		);

		const config = loadConfig(
			{
				VICISSITUDE_CONFIG_PATH: filepath,
				DISCORD_TOKEN: "test-token",
			},
			root,
		);

		expect(config.discordDm).toEqual({
			allowedUserIds: ["883258849254072341"],
		});
	});
});
