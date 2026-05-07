import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolve } from "path";

import { buildCoreEnvironment } from "../../apps/discord/src/bootstrap.ts";
import type { AppConfig } from "../../apps/discord/src/config.ts";

function makeConfig(
	overrides: {
		spotify?: AppConfig["spotify"];
		genius?: AppConfig["genius"];
		shellWorkspace?: AppConfig["shellWorkspace"];
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
	let savedEmotionChatModel: string | undefined;

	beforeEach(() => {
		savedEmotionChatModel = process.env.EMOTION_CHAT_MODEL;
		delete process.env.EMOTION_CHAT_MODEL;
	});

	afterEach(() => {
		if (savedEmotionChatModel === undefined) {
			delete process.env.EMOTION_CHAT_MODEL;
		} else {
			process.env.EMOTION_CHAT_MODEL = savedEmotionChatModel;
		}
	});

	it("常に必須の環境変数を含む", () => {
		const result = buildCoreEnvironment(makeConfig(), ROOT);
		const requiredKeys = [
			"PATH",
			"HOME",
			"DISCORD_TOKEN",
			"OLLAMA_BASE_URL",
			"MEMORY_EMBEDDING_MODEL",
			"MEMORY_DATA_DIR",
			"DATA_DIR",
			"EMOTION_CHAT_MODEL",
		];
		for (const key of requiredKeys) {
			expect(result).toHaveProperty(key);
		}
	});

	it("DISCORD_TOKEN は config.discordToken の値", () => {
		const result = buildCoreEnvironment(makeConfig(), ROOT);
		expect(result.DISCORD_TOKEN).toBe("test-discord-token");
	});

	it("OLLAMA_BASE_URL は config.memory.ollamaBaseUrl の値", () => {
		const result = buildCoreEnvironment(makeConfig(), ROOT);
		expect(result.OLLAMA_BASE_URL).toBe("http://localhost:11434");
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

	describe("EMOTION_CHAT_MODEL", () => {
		it("環境変数が設定されている場合はその値を使用する", () => {
			process.env.EMOTION_CHAT_MODEL = "custom-model";
			const result = buildCoreEnvironment(makeConfig(), ROOT);
			expect(result.EMOTION_CHAT_MODEL).toBe("custom-model");
		});

		it("環境変数が未設定の場合は 'gemma3' をデフォルトにする", () => {
			delete process.env.EMOTION_CHAT_MODEL;
			const result = buildCoreEnvironment(makeConfig(), ROOT);
			expect(result.EMOTION_CHAT_MODEL).toBe("gemma3");
		});
	});

	describe("Spotify 環境変数", () => {
		it("config.spotify が存在する場合は Spotify 環境変数を含む", () => {
			const config = makeConfig({
				spotify: {
					clientId: "sp-id",
					clientSecret: "sp-secret",
					refreshToken: "sp-refresh",
				},
			});
			const result = buildCoreEnvironment(config, ROOT);
			expect(result.SPOTIFY_CLIENT_ID).toBe("sp-id");
			expect(result.SPOTIFY_CLIENT_SECRET).toBe("sp-secret");
			expect(result.SPOTIFY_REFRESH_TOKEN).toBe("sp-refresh");
		});

		it("config.spotify.recommendPlaylistId が存在する場合は SPOTIFY_RECOMMEND_PLAYLIST_ID を含む", () => {
			const config = makeConfig({
				spotify: {
					clientId: "sp-id",
					clientSecret: "sp-secret",
					refreshToken: "sp-refresh",
					recommendPlaylistId: "playlist-123",
				},
			});
			const result = buildCoreEnvironment(config, ROOT);
			expect(result.SPOTIFY_RECOMMEND_PLAYLIST_ID).toBe("playlist-123");
		});

		it("config.spotify.recommendPlaylistId が存在しない場合は SPOTIFY_RECOMMEND_PLAYLIST_ID を含まない", () => {
			const config = makeConfig({
				spotify: {
					clientId: "sp-id",
					clientSecret: "sp-secret",
					refreshToken: "sp-refresh",
				},
			});
			const result = buildCoreEnvironment(config, ROOT);
			expect(result).not.toHaveProperty("SPOTIFY_RECOMMEND_PLAYLIST_ID");
		});

		it("config.spotify が存在しない場合は Spotify 環境変数を含まない", () => {
			const result = buildCoreEnvironment(makeConfig(), ROOT);
			expect(result).not.toHaveProperty("SPOTIFY_CLIENT_ID");
			expect(result).not.toHaveProperty("SPOTIFY_CLIENT_SECRET");
			expect(result).not.toHaveProperty("SPOTIFY_REFRESH_TOKEN");
			expect(result).not.toHaveProperty("SPOTIFY_RECOMMEND_PLAYLIST_ID");
		});
	});

	describe("Genius 環境変数", () => {
		it("config.genius が存在する場合は GENIUS_ACCESS_TOKEN を含む", () => {
			const config = makeConfig({
				genius: { accessToken: "genius-token" },
			});
			const result = buildCoreEnvironment(config, ROOT);
			expect(result.GENIUS_ACCESS_TOKEN).toBe("genius-token");
		});

		it("config.genius が存在しない場合は GENIUS_ACCESS_TOKEN を含まない", () => {
			const result = buildCoreEnvironment(makeConfig(), ROOT);
			expect(result).not.toHaveProperty("GENIUS_ACCESS_TOKEN");
		});
	});

	describe("Shell workspace 環境変数", () => {
		it("config.shellWorkspace が存在する場合は添付許可ディレクトリを含む", () => {
			const config = makeConfig({
				shellWorkspace: {
					enabled: true,
					image: "sandbox",
					dataDir: "/tmp/shell-workspaces",
					auditLogPath: "/tmp/shell-audit.jsonl",
					defaultTtlMinutes: 60,
					maxTtlMinutes: 120,
					defaultTimeoutSeconds: 30,
					maxTimeoutSeconds: 120,
					maxOutputChars: 50_000,
				},
			});
			const result = buildCoreEnvironment(config, ROOT);

			expect(result.DISCORD_ATTACHMENT_ALLOWED_DIRS).toBe("/tmp/shell-workspaces");
		});

		it("config.shellWorkspace が存在しない場合は添付許可ディレクトリを追加しない", () => {
			const result = buildCoreEnvironment(makeConfig(), ROOT);

			expect(result).not.toHaveProperty("DISCORD_ATTACHMENT_ALLOWED_DIRS");
		});
	});
});
