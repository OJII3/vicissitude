import { describe, expect, it } from "bun:test";

import { loadConfig } from "@vicissitude/shared/config";

function baseEnv(overrides: Record<string, string> = {}): Record<string, string> {
	return {
		DISCORD_TOKEN: "test-token",
		...overrides,
	};
}

describe("loadConfig", () => {
	const root = "/tmp/test-vicissitude";

	it("全デフォルト値で設定が返る", () => {
		const config = loadConfig(baseEnv(), root);

		expect(config.discordToken).toBe("test-token");
		expect(config.opencode.providerId).toBe("github-copilot");
		expect(config.opencode.modelId).toBe("big-pickle");
		expect(config.opencode.basePort).toBe(4096);
		expect(config.opencode.sessionMaxAgeHours).toBe(48);
		expect(config.ltm.providerId).toBe("github-copilot");
		expect(config.ltm.modelId).toBe("gpt-4o");
		expect(config.ltm.ollamaBaseUrl).toBe("http://ollama:11434");
		expect(config.ltm.embeddingModel).toBe("embeddinggemma");
		expect(config.minecraft).toBeUndefined();
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
				LTM_PROVIDER_ID: "ltm-provider",
				LTM_MODEL_ID: "ltm-model",
				OLLAMA_BASE_URL: "http://localhost:11434",
				LTM_EMBEDDING_MODEL: "custom-embedding",
			}),
			root,
		);

		expect(config.opencode.providerId).toBe("custom-provider");
		expect(config.opencode.modelId).toBe("custom-model");
		expect(config.opencode.basePort).toBe(5000);
		expect(config.opencode.sessionMaxAgeHours).toBe(24);
		expect(config.ltm.providerId).toBe("ltm-provider");
		expect(config.ltm.modelId).toBe("ltm-model");
		expect(config.ltm.ollamaBaseUrl).toBe("http://localhost:11434");
		expect(config.ltm.embeddingModel).toBe("custom-embedding");
	});

	it("LTM_PROVIDER_ID 未指定時は OPENCODE_PROVIDER_ID にフォールバック", () => {
		const config = loadConfig(
			baseEnv({
				OPENCODE_PROVIDER_ID: "my-provider",
			}),
			root,
		);

		expect(config.ltm.providerId).toBe("my-provider");
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
});
