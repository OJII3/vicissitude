import { describe, expect, it } from "bun:test";

import { loadConfig, loadConfigFromProfile } from "../../apps/discord/src/config.ts";

function baseEnv(overrides: Record<string, string> = {}): Record<string, string> {
	return {
		DISCORD_TOKEN: "test-token",
		...overrides,
	};
}

describe("loadConfig", () => {
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

	it("全デフォルト値で設定が返る", () => {
		const config = loadConfig(baseEnv(), root);

		expect(config.discordToken).toBe("test-token");
		expect(config.opencode.providerId).toBe("github-copilot");
		expect(config.opencode.modelId).toBe("big-pickle");
		expect(config.opencode.basePort).toBe(4096);
		expect(config.opencode.sessionMaxAgeHours).toBe(48);
		expect(config.opencode.temperature).toBe(1.0);
		expect(config.mcBrain.providerId).toBe("github-copilot");
		expect(config.mcBrain.modelId).toBe("big-pickle");
		expect(config.mcBrain.temperature).toBe(0.7);
		expect(config.memory.providerId).toBe("github-copilot");
		expect(config.memory.modelId).toBe("gpt-4o");
		expect(config.memory.ollamaBaseUrl).toBe("http://ollama:11434");
		expect(config.memory.embeddingModel).toBe("embeddinggemma");
		expect(config.minecraft).toBeUndefined();
		expect(config.shellWorkspace).toBeUndefined();
		expect(config.dataDir).toBe("/tmp/test-vicissitude/data");
		expect(config.contextDir).toBe("/tmp/test-vicissitude/context");
	});

	it("DISCORD_TOKEN が未設定で ZodError が throw される", () => {
		expect(() => loadConfig({}, root)).toThrow();
	});

	it("DISCORD_TOKEN が空文字で ZodError が throw される", () => {
		expect(() => loadConfig({ DISCORD_TOKEN: "" }, root)).toThrow();
	});

	it("環境変数のカスタム値が反映される", () => {
		const config = loadConfig(
			baseEnv({
				OPENCODE_PROVIDER_ID: "custom-provider",
				OPENCODE_MODEL_ID: "custom-model",
				OPENCODE_BASE_PORT: "5000",
				SESSION_MAX_AGE_HOURS: "24",
				OPENCODE_TEMPERATURE: "0.5",
				MC_PROVIDER_ID: "mc-provider",
				MC_MODEL_ID: "mc-model",
				MC_TEMPERATURE: "0.3",
				MEMORY_PROVIDER_ID: "memory-provider",
				MEMORY_MODEL_ID: "memory-model",
				OLLAMA_BASE_URL: "http://localhost:11434",
				MEMORY_EMBEDDING_MODEL: "custom-embedding",
			}),
			root,
		);

		expect(config.opencode.providerId).toBe("custom-provider");
		expect(config.opencode.modelId).toBe("custom-model");
		expect(config.opencode.basePort).toBe(5000);
		expect(config.opencode.sessionMaxAgeHours).toBe(24);
		expect(config.opencode.temperature).toBe(0.5);
		expect(config.mcBrain.providerId).toBe("mc-provider");
		expect(config.mcBrain.modelId).toBe("mc-model");
		expect(config.mcBrain.temperature).toBe(0.3);
		expect(config.memory.providerId).toBe("memory-provider");
		expect(config.memory.modelId).toBe("memory-model");
		expect(config.memory.ollamaBaseUrl).toBe("http://localhost:11434");
		expect(config.memory.embeddingModel).toBe("custom-embedding");
	});

	it("MEMORY_PROVIDER_ID 未指定時は OPENCODE_PROVIDER_ID にフォールバック", () => {
		const config = loadConfig(
			baseEnv({
				OPENCODE_PROVIDER_ID: "my-provider",
			}),
			root,
		);

		expect(config.memory.providerId).toBe("my-provider");
	});

	it("MC_TEMPERATURE が範囲外なら ZodError が throw される", () => {
		expect(() => loadConfig(baseEnv({ MC_TEMPERATURE: "2.1" }), root)).toThrow();
	});

	describe("Minecraft", () => {
		it("MC_HOST が設定されていれば minecraft がセットされる", () => {
			const config = loadConfig(
				baseEnv({
					MC_HOST: "mc.example.com",
				}),
				root,
			);

			expect(config.minecraft).toBeDefined();
			expect(config.minecraft?.host).toBe("mc.example.com");
			expect(config.minecraft?.port).toBe(25565);
			expect(config.minecraft?.username).toBe("hua");
			expect(config.minecraft?.version).toBeUndefined();
			expect(config.minecraft?.mcpPort).toBe(3001);
			expect(config.minecraft?.viewerPort).toBe(3007);
			expect(config.minecraft?.authMode).toBe("offline");
			expect(config.minecraft?.profilesFolder).toBeUndefined();
		});

		it("MC_HOST が未設定なら minecraft は undefined", () => {
			const config = loadConfig(baseEnv(), root);
			expect(config.minecraft).toBeUndefined();
		});

		it("Minecraft のカスタム値が反映される", () => {
			const config = loadConfig(
				baseEnv({
					MC_HOST: "mc.example.com",
					MC_PORT: "25000",
					MC_USERNAME: "bot",
					MC_VERSION: "1.20.4",
					MC_AUTH_MODE: "microsoft",
					MC_PROFILES_FOLDER: "/tmp/mc-profiles",
					MC_MCP_PORT: "4000",
					MC_VIEWER_PORT: "5000",
				}),
				root,
			);

			expect(config.minecraft?.port).toBe(25000);
			expect(config.minecraft?.username).toBe("bot");
			expect(config.minecraft?.version).toBe("1.20.4");
			expect(config.minecraft?.authMode).toBe("microsoft");
			expect(config.minecraft?.profilesFolder).toBe("/tmp/mc-profiles");
			expect(config.minecraft?.mcpPort).toBe(4000);
			expect(config.minecraft?.viewerPort).toBe(5000);
		});
	});

	describe("Shell workspace", () => {
		it("SHELL_WORKSPACE_ENABLED が設定されていれば shellWorkspace がセットされる", () => {
			const config = loadConfig(
				baseEnv({
					SHELL_WORKSPACE_ENABLED: "true",
				}),
				root,
			);

			expect(config.shellWorkspace).toEqual({
				enabled: true,
				image: "vicissitude-code-exec",
				dataDir: "/tmp/test-vicissitude/data/shell-workspaces",
				auditLogPath: "/tmp/test-vicissitude/data/shell-workspace-audit.jsonl",
				defaultTtlMinutes: 60,
				maxTtlMinutes: 120,
				defaultTimeoutSeconds: 30,
				maxTimeoutSeconds: 120,
				maxOutputChars: 50_000,
			});
		});

		it("Shell workspace のカスタム値が反映される", () => {
			const config = loadConfig(
				baseEnv({
					SHELL_WORKSPACE_ENABLED: "1",
					SHELL_WORKSPACE_IMAGE: "custom-shell-image",
					SHELL_WORKSPACE_DEFAULT_TTL_MINUTES: "10",
					SHELL_WORKSPACE_MAX_TTL_MINUTES: "20",
					SHELL_WORKSPACE_DEFAULT_TIMEOUT_SECONDS: "5",
					SHELL_WORKSPACE_MAX_TIMEOUT_SECONDS: "9",
					SHELL_WORKSPACE_MAX_OUTPUT_CHARS: "12345",
				}),
				root,
			);

			expect(config.shellWorkspace?.image).toBe("custom-shell-image");
			expect(config.shellWorkspace?.defaultTtlMinutes).toBe(10);
			expect(config.shellWorkspace?.maxTtlMinutes).toBe(20);
			expect(config.shellWorkspace?.defaultTimeoutSeconds).toBe(5);
			expect(config.shellWorkspace?.maxTimeoutSeconds).toBe(9);
			expect(config.shellWorkspace?.maxOutputChars).toBe(12_345);
		});

		it("Shell workspace の既定 TTL が上限を超える場合はエラーにする", () => {
			expect(() =>
				loadConfig(
					baseEnv({
						SHELL_WORKSPACE_ENABLED: "true",
						SHELL_WORKSPACE_DEFAULT_TTL_MINUTES: "30",
						SHELL_WORKSPACE_MAX_TTL_MINUTES: "10",
					}),
					root,
				),
			).toThrow("SHELL_WORKSPACE_DEFAULT_TTL_MINUTES");
		});
	});

	describe("JSON profile", () => {
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
			);

			expect(config.imageRecognition).toEqual({
				enabled: true,
				providerId: "vision-provider",
				modelId: "vision-model",
			});
			expect(config.shellWorkspace).toEqual({
				enabled: true,
				image: "shell-image",
				dataDir: "/tmp/test-vicissitude/data/shell-workspaces",
				auditLogPath: "/tmp/test-vicissitude/data/shell-workspace-audit.jsonl",
				defaultTtlMinutes: 15,
				maxTtlMinutes: 30,
				defaultTimeoutSeconds: 5,
				maxTimeoutSeconds: 10,
				maxOutputChars: 12345,
			});
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
	});
});
