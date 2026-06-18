import { describe, expect, it } from "bun:test";
import { resolve } from "path";

import {
	buildAgentDiscordEnvironment,
	buildCoreEnvironment,
	buildDiscordEnvironment,
} from "../../../apps/discord/src/bootstrap/environment.ts";
import type { AppConfig } from "../../../apps/discord/src/config.ts";

function makeConfig(
	overrides: {
		shellAgent?: AppConfig["shellAgent"];
		emotionEstimation?: AppConfig["emotionEstimation"];
		minecraft?: AppConfig["minecraft"];
	} = {},
): AppConfig {
	return {
		discordToken: "test-discord-token",
		webPort: 3000,
		gatewayPort: 3001,
		opencode: {
			providerId: "test-provider",
			modelId: "test-model",
			basePort: 5000,
			sessionMaxAgeHours: 1,
			temperature: 1.0,
		},
		memory: {
			providerId: "memory-provider",
			modelId: "memory-model",
			ollamaBaseUrl: "http://localhost:11434",
			embeddingModel: "nomic-embed-text",
		},
		mcBrain: {
			providerId: "mc-provider",
			modelId: "mc-model",
			temperature: 0.7,
		},
		dataDir: "/tmp/test-data",
		contextDir: "/tmp/test-context",
		...overrides,
	} as AppConfig;
}

const ROOT = "/tmp/test-root";

describe("buildCoreEnvironment", () => {
	it("常に必須の環境変数を含む", () => {
		const result = buildCoreEnvironment(makeConfig(), ROOT);
		const requiredKeys = [
			"PATH",
			"HOME",
			"OLLAMA_BASE_URL",
			"MEMORY_OLLAMA_BASE_URL",
			"MEMORY_EMBEDDING_MODEL",
			"MEMORY_DATA_DIR",
			"DATA_DIR",
		];
		for (const key of requiredKeys) {
			expect(result).toHaveProperty(key);
		}
	});

	it("Discord 固有の環境変数を含まない", () => {
		const result = buildCoreEnvironment(makeConfig(), ROOT);
		expect(result).not.toHaveProperty("DISCORD_TOKEN");
		expect(result).not.toHaveProperty("DISCORD_ATTACHMENT_ALLOWED_DIRS");
		expect(result).not.toHaveProperty("EMOTION_ESTIMATION_ENABLED");
	});

	it("OLLAMA_BASE_URL は config.memory.ollamaBaseUrl の値", () => {
		const result = buildCoreEnvironment(makeConfig(), ROOT);
		expect(result.OLLAMA_BASE_URL).toBe("http://localhost:11434");
	});

	it("MEMORY_OLLAMA_BASE_URL は config.memory.ollamaBaseUrl の値", () => {
		const result = buildCoreEnvironment(makeConfig(), ROOT);
		expect(result.MEMORY_OLLAMA_BASE_URL).toBe("http://localhost:11434");
	});

	it("MEMORY_EMBEDDING_MODEL は config.memory.embeddingModel の値", () => {
		const result = buildCoreEnvironment(makeConfig(), ROOT);
		expect(result.MEMORY_EMBEDDING_MODEL).toBe("nomic-embed-text");
	});

	it("MEMORY_DATA_DIR は resolve(config.dataDir, 'memory') の値", () => {
		const result = buildCoreEnvironment(makeConfig(), ROOT);
		expect(result.MEMORY_DATA_DIR).toBe(resolve("/tmp/test-data", "memory"));
	});

	it("DATA_DIR は resolve(root, 'data') の値", () => {
		const result = buildCoreEnvironment(makeConfig(), ROOT);
		expect(result.DATA_DIR).toBe(resolve(ROOT, "data"));
	});
});

describe("buildDiscordEnvironment", () => {
	it("Discord MCP に必要な環境変数を含む", () => {
		const result = buildDiscordEnvironment(makeConfig(), ROOT);
		const requiredKeys = ["PATH", "HOME", "DISCORD_TOKEN", "DATA_DIR"];
		for (const key of requiredKeys) {
			expect(result).toHaveProperty(key);
		}
	});

	it("DISCORD_TOKEN は config.discordToken の値", () => {
		const result = buildDiscordEnvironment(makeConfig(), ROOT);
		expect(result.DISCORD_TOKEN).toBe("test-discord-token");
	});

	it("DATA_DIR は resolve(root, 'data') の値", () => {
		const result = buildDiscordEnvironment(makeConfig(), ROOT);
		expect(result.DATA_DIR).toBe(resolve(ROOT, "data"));
	});

	it("config.minecraft が存在する場合は Minecraft bridge 用 MC_HOST を含む", () => {
		const result = buildDiscordEnvironment(
			makeConfig({
				minecraft: {
					host: "mc.example.com",
					port: 25565,
					username: "hua",
					authMode: "offline",
					mcpPort: 3001,
					viewerPort: 3007,
				},
			}),
			ROOT,
		);

		expect(result.MC_HOST).toBe("mc.example.com");
	});

	describe("感情推定環境変数", () => {
		it("デフォルトでは感情推定の環境変数を含まない", () => {
			const result = buildDiscordEnvironment(makeConfig(), ROOT);
			expect(result).not.toHaveProperty("EMOTION_ESTIMATION_ENABLED");
			expect(result).not.toHaveProperty("EMOTION_PROVIDER_ID");
			expect(result).not.toHaveProperty("EMOTION_MODEL_ID");
			expect(result).not.toHaveProperty("EMOTION_OLLAMA_BASE_URL");
		});

		it("有効な場合は provider と model を渡す", () => {
			const result = buildDiscordEnvironment(
				makeConfig({
					emotionEstimation: {
						enabled: true,
						providerId: "openai",
						modelId: "gpt-5.4",
					},
				}),
				ROOT,
			);

			expect(result.EMOTION_ESTIMATION_ENABLED).toBe("true");
			expect(result.EMOTION_PROVIDER_ID).toBe("openai");
			expect(result.EMOTION_MODEL_ID).toBe("gpt-5.4");
			expect(result).not.toHaveProperty("EMOTION_OLLAMA_BASE_URL");
		});

		it("ollama の場合は ollamaBaseUrl を渡す", () => {
			const result = buildDiscordEnvironment(
				makeConfig({
					emotionEstimation: {
						enabled: true,
						providerId: "ollama",
						modelId: "emotion-model",
						ollamaBaseUrl: "http://emotion-ollama:11434",
					},
				}),
				ROOT,
			);

			expect(result.EMOTION_PROVIDER_ID).toBe("ollama");
			expect(result.EMOTION_MODEL_ID).toBe("emotion-model");
			expect(result.EMOTION_OLLAMA_BASE_URL).toBe("http://emotion-ollama:11434");
		});
	});

	describe("agent Discord 環境変数", () => {
		it("ollama 以外の感情推定 provider には専用 OpenCode port を渡す", () => {
			const baseEnvironment = buildDiscordEnvironment(
				makeConfig({
					emotionEstimation: {
						enabled: true,
						providerId: "openai",
						modelId: "gpt-5.4",
					},
				}),
				ROOT,
			);
			const result = buildAgentDiscordEnvironment(
				makeConfig({
					emotionEstimation: {
						enabled: true,
						providerId: "openai",
						modelId: "gpt-5.4",
					},
				}),
				baseEnvironment,
				5000,
			);

			expect(result.EMOTION_OPENCODE_PORT).toBe("6000");
			expect(baseEnvironment).not.toHaveProperty("EMOTION_OPENCODE_PORT");
		});

		it("感情推定が無効、または ollama の場合は baseEnvironment をそのまま使う", () => {
			const disabledBase = buildDiscordEnvironment(makeConfig(), ROOT);
			expect(buildAgentDiscordEnvironment(makeConfig(), disabledBase, 5000)).toBe(disabledBase);

			const ollamaConfig = makeConfig({
				emotionEstimation: {
					enabled: true,
					providerId: "ollama",
					modelId: "emotion-model",
					ollamaBaseUrl: "http://emotion-ollama:11434",
				},
			});
			const ollamaBase = buildDiscordEnvironment(ollamaConfig, ROOT);
			expect(buildAgentDiscordEnvironment(ollamaConfig, ollamaBase, 5000)).toBe(ollamaBase);
		});
	});

	describe("Shell agent 環境変数", () => {
		it("config.shellAgent が存在する場合は添付許可ディレクトリを含む", () => {
			const config = makeConfig({
				shellAgent: {
					enabled: true,
					agent: {
						providerId: "shell-provider",
						modelId: "shell-model",
					},
					dataDir: "/tmp/shell-workspaces",
				},
			});
			const result = buildDiscordEnvironment(config, ROOT);

			expect(result.DISCORD_ATTACHMENT_ALLOWED_DIRS).toBe("/tmp/shell-workspaces");
		});

		it("config.shellAgent が存在しない場合は添付許可ディレクトリを追加しない", () => {
			const result = buildDiscordEnvironment(makeConfig(), ROOT);

			expect(result).not.toHaveProperty("DISCORD_ATTACHMENT_ALLOWED_DIRS");
		});
	});
});
