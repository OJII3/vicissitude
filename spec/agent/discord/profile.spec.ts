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

	test("shell workspace 有効時は primary に code skill を許可する", () => {
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
		expect(profile.skillPermission).toEqual({ "*": "deny", code: "allow" });
		expect(profile.primaryTools).toEqual(["task", "skill"]);
		expect(build?.tools?.skill).toBe(true);
		expect(build?.permission?.skill).toEqual({ "*": "deny", code: "allow" });
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

	test("Minecraft 有効時は minecraft skill だけを primary agent に許可する", () => {
		const profile = createConversationProfile({
			providerId: "provider",
			modelId: "model",
			mcpServers: {},
			minecraftEnabled: true,
		});

		expect(profile.builtinTools.skill).toBe(true);
		expect(profile.skillPermission).toEqual({
			"*": "deny",
			minecraft: "allow",
		});
		expect(profile.opencodeAgents).toBeUndefined();
	});

	test("shell workspace と Minecraft の併用時は build agent に code と minecraft skill だけを許可する", () => {
		const profile = createConversationProfile({
			providerId: "provider",
			modelId: "model",
			mcpServers: {},
			minecraftEnabled: true,
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

		expect(profile.primaryTools).toEqual(["task", "skill"]);
		expect(build?.tools?.skill).toBe(true);
		expect(build?.permission?.skill).toEqual({
			"*": "deny",
			code: "allow",
			minecraft: "allow",
		});
		expect(worker?.tools?.skill).toBe(true);
		expect(worker?.permission?.skill).toEqual({
			"*": "deny",
			debug: "allow",
			"skill-creator": "allow",
		});
	});
});
