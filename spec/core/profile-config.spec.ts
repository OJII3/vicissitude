import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";

import { z } from "zod";

import {
	loadConfig,
	loadConfigFromProfile,
	loadProfileConfigFile,
} from "../../apps/discord/src/config.ts";
import { profileConfigSchema } from "../../apps/discord/src/profile-config.ts";

function baseEnv(overrides: Record<string, string> = {}): Record<string, string> {
	return {
		DISCORD_TOKEN: "test-token",
		...overrides,
	};
}

const root = "/tmp/test-vicissitude";
const baseProfile = {
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

describe("JSON profile config", () => {
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

	it("profileConfigSchema は外部から参照できる Zod schema として機能する", () => {
		const parsed = profileConfigSchema.parse(baseProfile);

		expect(parsed.ports.web).toBe(4100);
	});

	it("$schema metadata を含む profile も読み込める", () => {
		const parsed = profileConfigSchema.parse({
			$schema: "./profile.schema.json",
			...baseProfile,
		});

		expect(parsed.$schema).toBe("./profile.schema.json");
		expect(parsed.models.conversation.modelId).toBe("conversation-model");
	});

	it("JSON Schema ファイルは Zod schema から生成される内容と一致する", () => {
		const schemaFile = JSON.parse(readFileSync(resolve("config/profile.schema.json"), "utf8"));
		const generatedSchema = {
			$id: "https://github.com/OJII3/vicissitude/config/profile.schema.json",
			...z.toJSONSchema(profileConfigSchema, { target: "draft-7" }),
		};

		expect(schemaFile).toEqual(generatedSchema);
	});

	it("profile の値から AppConfig を構築する", () => {
		const config = loadConfigFromProfile(baseProfile, baseEnv(), root);

		expect(config.webPort).toBe(4100);
		expect(config.gatewayPort).toBe(4101);
		expect(config.opencode).toEqual({
			providerId: "conversation-provider",
			modelId: "conversation-model",
			basePort: 5000,
			sessionMaxAgeHours: 24,
			temperature: 0.8,
		});
		expect(config.memory).toEqual({
			providerId: "memory-provider",
			modelId: "memory-model",
			ollamaBaseUrl: "http://localhost:11434",
			embeddingModel: "embedding-model",
		});
		expect(config.mcBrain).toEqual({
			providerId: "mc-provider",
			modelId: "mc-model",
			temperature: 0.4,
		});
	});

	it("profile の disabled feature は key ごと省略する", () => {
		const config = loadConfigFromProfile(baseProfile, baseEnv(), root);

		expect(config.imageRecognition).toBeUndefined();
		expect(config.shellWorkspace).toBeUndefined();
		expect(config.minecraft).toBeUndefined();
		expect(config.spotify).toBeUndefined();
	});

	it("profile に feature section がある場合だけ機能設定を作る", () => {
		const config = loadConfigFromProfile(
			{
				...baseProfile,
				features: {
					imageRecognition: {
						providerId: "vision-provider",
						modelId: "vision-model",
					},
					shellWorkspace: {
						image: "shell-image",
						agent: {
							providerId: "shell-provider",
							modelId: "shell-model",
							temperature: 0.3,
							steps: 16,
						},
						environment: {
							GH_TOKEN: { fromEnv: "HUA_GITHUB_TOKEN" },
							GITHUB_TOKEN: { fromEnv: "HUA_GITHUB_TOKEN" },
						},
						defaultTtlMinutes: 15,
						maxTtlMinutes: 30,
						defaultTimeoutSeconds: 5,
						maxTimeoutSeconds: 10,
						maxOutputChars: 12345,
					},
				},
			},
			baseEnv({ HUA_GITHUB_TOKEN: "test-github-token" }),
			root,
		);

		expect(config.imageRecognition).toEqual({
			enabled: true,
			providerId: "vision-provider",
			modelId: "vision-model",
		});
		expect(config.shellWorkspace).toEqual({
			enabled: true,
			image: "shell-image",
			agent: {
				providerId: "shell-provider",
				modelId: "shell-model",
				temperature: 0.3,
				steps: 16,
			},
			environment: {
				GH_TOKEN: "test-github-token",
				GITHUB_TOKEN: "test-github-token",
			},
			dataDir: "/tmp/test-vicissitude/data/shell-workspaces",
			auditLogPath: "/tmp/test-vicissitude/data/shell-workspace-audit.jsonl",
			networkProfile: "open",
			defaultTtlMinutes: 15,
			maxTtlMinutes: 30,
			defaultTimeoutSeconds: 5,
			maxTimeoutSeconds: 10,
			maxOutputChars: 12345,
		});
	});

	it("shellWorkspace.environment の参照元 env が未設定ならエラーにする", () => {
		expect(() =>
			loadConfigFromProfile(
				{
					...baseProfile,
					features: {
						shellWorkspace: {
							image: "shell-image",
							agent: {
								providerId: "shell-provider",
								modelId: "shell-model",
								temperature: 0.3,
								steps: 16,
							},
							environment: {
								GH_TOKEN: { fromEnv: "HUA_GITHUB_TOKEN" },
							},
							defaultTtlMinutes: 15,
							maxTtlMinutes: 30,
							defaultTimeoutSeconds: 5,
							maxTimeoutSeconds: 10,
							maxOutputChars: 12345,
						},
					},
				},
				baseEnv(),
				root,
			),
		).toThrow("HUA_GITHUB_TOKEN is required");
	});

	it("secret が必要な feature は env 未設定ならエラーにする", () => {
		expect(() =>
			loadConfigFromProfile(
				{
					...baseProfile,
					features: {
						spotify: {},
					},
				},
				baseEnv(),
				root,
			),
		).toThrow("SPOTIFY_CLIENT_ID is required");
	});

	it("Spotify 推薦プレイリスト設定を profile から AppConfig に反映する", () => {
		const config = loadConfigFromProfile(
			{
				...baseProfile,
				features: {
					spotify: {
						recommendPlaylistId: "profile-playlist",
					},
				},
			},
			baseEnv({
				SPOTIFY_CLIENT_ID: "spotify-client-id",
				SPOTIFY_CLIENT_SECRET: "spotify-client-secret",
				SPOTIFY_REFRESH_TOKEN: "spotify-refresh-token",
			}),
			root,
		);

		expect(config.spotify?.recommendPlaylistId).toBe("profile-playlist");
	});

	it("profile 未指定時は既存 env の Spotify 推薦プレイリスト設定を維持する", () => {
		const config = loadConfigFromProfile(
			{
				...baseProfile,
				features: {
					spotify: {},
				},
			},
			baseEnv({
				SPOTIFY_CLIENT_ID: "spotify-client-id",
				SPOTIFY_CLIENT_SECRET: "spotify-client-secret",
				SPOTIFY_REFRESH_TOKEN: "spotify-refresh-token",
				SPOTIFY_RECOMMEND_PLAYLIST_ID: "env-playlist",
			}),
			root,
		);

		expect(config.spotify?.recommendPlaylistId).toBe("env-playlist");
	});

	it("JSON ファイルをパースして profile を読み込む", () => {
		const filepath = writeProfileFile(baseProfile);
		const profile = loadProfileConfigFile(filepath);

		expect(profile).toEqual(baseProfile);
	});

	it("JSON ファイルに未知 key がある場合はエラーにする", () => {
		const filepath = writeProfileFile({
			...baseProfile,
			unknown: true,
		});

		expect(() => loadProfileConfigFile(filepath)).toThrow();
	});

	it("JSON ファイルの nested object に未知 key がある場合もエラーにする", () => {
		const filepath = writeProfileFile({
			...baseProfile,
			models: {
				...baseProfile.models,
				conversation: {
					...baseProfile.models.conversation,
					unknown: true,
				},
			},
		});

		expect(() => loadProfileConfigFile(filepath)).toThrow();
	});

	it("VICISSITUDE_CONFIG_PATH 指定時は JSON profile から設定を読み込む", () => {
		const filepath = writeProfileFile(baseProfile);
		const config = loadConfig(
			baseEnv({
				VICISSITUDE_CONFIG_PATH: filepath,
			}),
			root,
		);

		expect(config.opencode.providerId).toBe("conversation-provider");
		expect(config.opencode.modelId).toBe("conversation-model");
		expect(config.webPort).toBe(4100);
	});
});
