import { describe, expect, test } from "bun:test";

import { createConversationProfile } from "@vicissitude/agent/discord/profile";

describe("createConversationProfile", () => {
	test("pollingPrompt が system context の人格定義に従う指示を含む", () => {
		const profile = createConversationProfile({
			providerId: "provider",
			modelId: "model",
			mcpServers: {},
		});

		expect(profile.pollingPrompt).toContain("システム文脈");
		expect(profile.pollingPrompt).toContain("人格");
	});

	test("pollingPrompt が discord_send_message の使用を必須指示として含む", () => {
		const profile = createConversationProfile({
			providerId: "provider",
			modelId: "model",
			mcpServers: {},
		});

		expect(profile.pollingPrompt).toContain("discord_send_message");
		expect(profile.pollingPrompt).not.toContain("core_send_message");
	});

	test("pollingPrompt に action ヒントの説明が含まれる", () => {
		const profile = createConversationProfile({
			providerId: "provider",
			modelId: "model",
			mcpServers: {},
		});

		expect(profile.pollingPrompt).toContain("respond");
	});

	test("shell workspace 有効時は shell-worker だけ許可済み skill を使える", () => {
		const profile = createConversationProfile({
			providerId: "provider",
			modelId: "model",
			mcpServers: {},
			shellWorkspaceSubagent: {
				providerId: "worker-provider",
				modelId: "worker-model",
				temperature: 0.4,
				steps: 12,
			},
		});

		const build = profile.opencodeAgents?.build as
			| { tools?: Record<string, boolean>; permission?: Record<string, unknown> }
			| undefined;
		const worker = profile.opencodeAgents?.["shell-worker"] as
			| { tools?: Record<string, boolean>; permission?: Record<string, unknown> }
			| undefined;

		expect(profile.builtinTools.skill).toBe(true);
		expect(profile.skillPermission).toEqual({ "*": "deny" });
		expect(build?.tools?.skill).toBe(false);
		expect(build?.permission?.skill).toEqual({ "*": "deny" });
		expect(worker?.tools?.skill).toBe(true);
		expect(worker?.permission?.skill).toEqual({
			"*": "deny",
			debug: "allow",
			"skill-creator": "allow",
		});
	});

	test("shell workspace 無効時は OpenCode Skills を全拒否する", () => {
		const profile = createConversationProfile({
			providerId: "provider",
			modelId: "model",
			mcpServers: {},
		});

		expect(profile.builtinTools.skill).toBe(false);
		expect(profile.skillPermission).toEqual({ "*": "deny" });
		expect(profile.opencodeAgents).toBeUndefined();
	});
});
