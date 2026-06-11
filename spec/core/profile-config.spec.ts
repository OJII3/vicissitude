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
	features: {
		minecraft: {
			host: "localhost",
			port: 25565,
			username: "hua",
			authMode: "offline" as const,
			mcpPort: 3001,
			viewerPort: 3002,
		},
	},
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

	it("models.minecraft と features.minecraft が両方存在する profile を受理する", () => {
		expect(profileConfigSchema.safeParse(baseProfile).success).toBe(true);
	});

	it("models.minecraft と features.minecraft が両方不在の profile を受理する", () => {
		const { minecraft: _model, ...models } = baseProfile.models;
		const { minecraft: _feature, ...features } = baseProfile.features;

		expect(profileConfigSchema.safeParse({ ...baseProfile, models, features }).success).toBe(true);
	});

	it("models.minecraft だけが存在する profile を reject する", () => {
		const { minecraft: _omit, ...features } = baseProfile.features;

		expect(profileConfigSchema.safeParse({ ...baseProfile, features }).success).toBe(false);
	});

	it("features.minecraft だけが存在する profile を reject する", () => {
		const { minecraft: _omit, ...models } = baseProfile.models;

		expect(profileConfigSchema.safeParse({ ...baseProfile, models }).success).toBe(false);
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
		expect(config.heartbeatOpencode).toEqual({
			providerId: "heartbeat-provider",
			modelId: "heartbeat-model",
			temperature: 0.3,
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
		const { minecraft: _model, ...models } = baseProfile.models;
		const { minecraft: _feature, ...features } = baseProfile.features;
		const config = loadConfigFromProfile({ ...baseProfile, models, features }, baseEnv(), root);

		expect(config.imageRecognition).toBeUndefined();
		expect(config.emotionEstimation).toBeUndefined();
		expect(config.shellAgent).toBeUndefined();
		expect(config.minecraft).toBeUndefined();
	});

	it("minecraft 未設定の profile でも AppConfig を構築でき mcBrain と minecraft は undefined になる", () => {
		const { minecraft: _model, ...models } = baseProfile.models;
		const { minecraft: _feature, ...features } = baseProfile.features;
		const config = loadConfigFromProfile({ ...baseProfile, models, features }, baseEnv(), root);

		expect(config.mcBrain).toBeUndefined();
		expect(config.minecraft).toBeUndefined();
	});

	it("profile に feature section がある場合だけ機能設定を作る", () => {
		const config = loadConfigFromProfile(
			{
				...baseProfile,
				features: {
					...baseProfile.features,
					imageRecognition: {
						providerId: "vision-provider",
						modelId: "vision-model",
					},
					discordDm: {
						allowedUserIds: ["123456789012345678"],
					},
					emotionEstimation: {
						providerId: "openai",
						modelId: "gpt-5.4",
					},
					shellAgent: {
						agent: {
							providerId: "shell-provider",
							modelId: "shell-model",
						},
						environment: {
							GH_TOKEN: { fromEnv: "HUA_GITHUB_TOKEN" },
							GITHUB_TOKEN: { fromEnv: "HUA_GITHUB_TOKEN" },
						},
						git: {
							userName: "ふあ",
							userEmail: "282728168+agenthua@users.noreply.github.com",
						},
						backgroundSubagents: true,
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
		expect(config.discordDm).toEqual({
			allowedUserIds: ["123456789012345678"],
		});
		expect(config.emotionEstimation).toEqual({
			enabled: true,
			providerId: "openai",
			modelId: "gpt-5.4",
			ollamaBaseUrl: undefined,
		});
		expect(config.shellAgent).toEqual({
			enabled: true,
			agent: {
				providerId: "shell-provider",
				modelId: "shell-model",
			},
			environment: {
				GH_TOKEN: "test-github-token",
				GITHUB_TOKEN: "test-github-token",
			},
			git: {
				userName: "ふあ",
				userEmail: "282728168+agenthua@users.noreply.github.com",
			},
			backgroundSubagents: true,
			dataDir: "/tmp/test-vicissitude/data/shell-workspaces",
		});
	});

	it("features.emailCheck 設定時に endpoint/token を env から解決する", () => {
		const config = loadConfigFromProfile(
			{
				...baseProfile,
				features: { ...baseProfile.features, emailCheck: {} },
			},
			baseEnv({
				GAS_EMAIL_ENDPOINT: "https://script.google.com/exec",
				GAS_EMAIL_TOKEN: "test-email-token",
			}),
			root,
		);

		expect(config.emailCheck).toEqual({
			endpoint: "https://script.google.com/exec",
			token: "test-email-token",
		});
	});

	it("features.emailCheck 未設定なら emailCheck は undefined になる", () => {
		const config = loadConfigFromProfile(baseProfile, baseEnv(), root);

		expect(config.emailCheck).toBeUndefined();
	});

	it("features.emailCheck 設定時に GAS_EMAIL_ENDPOINT が無ければエラーにする", () => {
		expect(() =>
			loadConfigFromProfile(
				{ ...baseProfile, features: { ...baseProfile.features, emailCheck: {} } },
				baseEnv({ GAS_EMAIL_TOKEN: "test-email-token" }),
				root,
			),
		).toThrow("GAS_EMAIL_ENDPOINT is required");
	});

	it("features.emailCheck 設定時に GAS_EMAIL_TOKEN が無ければエラーにする", () => {
		expect(() =>
			loadConfigFromProfile(
				{ ...baseProfile, features: { ...baseProfile.features, emailCheck: {} } },
				baseEnv({ GAS_EMAIL_ENDPOINT: "https://script.google.com/exec" }),
				root,
			),
		).toThrow("GAS_EMAIL_TOKEN is required");
	});

	it("shellAgent.environment の参照元 env が未設定ならエラーにする", () => {
		expect(() =>
			loadConfigFromProfile(
				{
					...baseProfile,
					features: {
						...baseProfile.features,
						shellAgent: {
							agent: {
								providerId: "shell-provider",
								modelId: "shell-model",
							},
							environment: {
								GH_TOKEN: { fromEnv: "HUA_GITHUB_TOKEN" },
							},
						},
					},
				},
				baseEnv(),
				root,
			),
		).toThrow("HUA_GITHUB_TOKEN is required");
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
