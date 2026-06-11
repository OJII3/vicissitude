import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";

import { appConfigSchema } from "../../apps/discord/src/config-schema.ts";
import { loadConfig } from "../../apps/discord/src/config.ts";

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

const baseAppConfig = {
	discordToken: "test-token",
	webPort: 4100,
	gatewayPort: 4101,
	opencode: {
		providerId: "conversation-provider",
		modelId: "conversation-model",
		basePort: 5000,
		sessionMaxAgeHours: 24,
		temperature: 0.8,
	},
	heartbeatOpencode: {
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
	dataDir: "/tmp/test-vicissitude/data",
	contextDir: "/tmp/test-vicissitude/context",
};

function env(filepath: string, overrides: Record<string, string> = {}): Record<string, string> {
	return {
		VICISSITUDE_CONFIG_PATH: filepath,
		DISCORD_TOKEN: "test-token",
		...overrides,
	};
}

describe("appConfigSchema", () => {
	const minecraft = {
		host: "localhost",
		port: 25565,
		username: "hua",
		authMode: "offline" as const,
		mcpPort: 3001,
		viewerPort: 3002,
	};
	const mcBrain = {
		providerId: "mc-provider",
		modelId: "mc-model",
		temperature: 0.4,
	};

	it("minecraft と mcBrain が両方存在する設定を受理する", () => {
		expect(appConfigSchema.safeParse({ ...baseAppConfig, minecraft, mcBrain }).success).toBe(true);
	});

	it("minecraft と mcBrain が両方不在の設定を受理する", () => {
		expect(appConfigSchema.safeParse(baseAppConfig).success).toBe(true);
	});

	it("minecraft だけが存在する設定を reject する", () => {
		expect(appConfigSchema.safeParse({ ...baseAppConfig, minecraft }).success).toBe(false);
	});

	it("mcBrain だけが存在する設定を reject する", () => {
		expect(appConfigSchema.safeParse({ ...baseAppConfig, mcBrain }).success).toBe(false);
	});
});

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

	it("JSON profile の値で AppConfig を構築する", () => {
		const filepath = writeProfileFile(baseProfile);
		const config = loadConfig(env(filepath), root);

		expect(config.discordToken).toBe("test-token");
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
		expect(config.dataDir).toBe("/tmp/test-vicissitude/data");
		expect(config.contextDir).toBe("/tmp/test-vicissitude/context");
	});

	it("DISCORD_TOKEN が未設定ならエラーにする", () => {
		const filepath = writeProfileFile(baseProfile);

		expect(() => loadConfig({ VICISSITUDE_CONFIG_PATH: filepath }, root)).toThrow(
			"DISCORD_TOKEN is required",
		);
	});

	it("旧 env loader の非 secret 設定は読み込まない", () => {
		const { minecraft: _model, ...models } = baseProfile.models;
		const { minecraft: _feature, ...features } = baseProfile.features;
		const filepath = writeProfileFile({ ...baseProfile, models, features });
		const config = loadConfig(
			env(filepath, {
				OPENCODE_PROVIDER_ID: "env-provider",
				MC_HOST: "mc.example.com",
				SHELL_WORKSPACE_ENABLED: "true",
				DISCORD_IMAGE_RECOGNITION_ENABLED: "true",
			}),
			root,
		);

		expect(config.opencode.providerId).toBe("conversation-provider");
		expect(config.minecraft).toBeUndefined();
		expect(config.shellAgent).toBeUndefined();
		expect(config.imageRecognition).toBeUndefined();
	});

	it("VICISSITUDE_CONFIG_PATH が未設定ならエラーにする", () => {
		expect(() => loadConfig({ DISCORD_TOKEN: "test-token" }, root)).toThrow(
			"VICISSITUDE_CONFIG_PATH is required",
		);
	});
});
