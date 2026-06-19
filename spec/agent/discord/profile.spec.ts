import { describe, expect, test } from "bun:test";

import { createConversationProfile } from "@vicissitude/agent/discord/profile";

describe("createConversationProfile", () => {
	test("pollingPrompt が system context の人格定義に従う指示を含む", () => {
		const { profile } = createConversationProfile({
			providerId: "provider",
			modelId: "model",
			mcpServers: {},
		});

		expect(profile.pollingPrompt).toContain("システム文脈");
		expect(profile.pollingPrompt).toContain("人格");
	});

	test("pollingPrompt が discord_send_message の使用を必須指示として含む", () => {
		const { profile } = createConversationProfile({
			providerId: "provider",
			modelId: "model",
			mcpServers: {},
		});

		expect(profile.pollingPrompt).toContain("discord_send_message");
		expect(profile.pollingPrompt).not.toContain("core_send_message");
	});

	test("pollingPrompt に action ヒントの説明が含まれる", () => {
		const { profile } = createConversationProfile({
			providerId: "provider",
			modelId: "model",
			mcpServers: {},
		});

		expect(profile.pollingPrompt).toContain("respond");
	});

	test("shell workspace 有効時は primary に delegate-to-shell-worker と self-update skill を許可する", () => {
		const { opencode } = createConversationProfile({
			providerId: "provider",
			modelId: "model",
			mcpServers: {},
			shellWorkspaceSubagent: {
				providerId: "worker-provider",
				modelId: "worker-model",
			},
		});

		const build = opencode.opencodeAgents?.build as
			| { tools?: Record<string, boolean>; permission?: Record<string, unknown> }
			| undefined;
		const worker = opencode.opencodeAgents?.["shell-worker"] as
			| { tools?: Record<string, boolean>; permission?: Record<string, unknown> }
			| undefined;

		expect(opencode.builtinTools.skill).toBe(true);
		expect(opencode.skillPermission).toEqual({
			"*": "deny",
			"delegate-to-shell-worker": "allow",
			"self-update": "allow",
		});
		expect(opencode.primaryTools).toEqual(["task", "skill"]);
		expect(build?.tools?.skill).toBe(true);
		expect(build?.permission?.skill).toEqual({
			"*": "deny",
			"delegate-to-shell-worker": "allow",
			"self-update": "allow",
		});
		expect(worker?.tools?.skill).toBe(true);
		expect(worker?.permission?.skill).toEqual({
			"*": "deny",
			debug: "allow",
			"skill-creator": "allow",
		});
	});

	test("self-update は shell workspace 無効時には許可しない", () => {
		const { opencode } = createConversationProfile({
			providerId: "provider",
			modelId: "model",
			mcpServers: {},
		});

		expect(opencode.skillPermission["self-update"]).toBeUndefined();
		expect(opencode.skillPermission).toEqual({ "*": "deny" });
	});

	test("self-update は Minecraft のみ有効時には許可しない", () => {
		const { opencode } = createConversationProfile({
			providerId: "provider",
			modelId: "model",
			mcpServers: {},
			minecraftEnabled: true,
		});

		expect(opencode.skillPermission["self-update"]).toBeUndefined();
		expect(opencode.skillPermission).toEqual({
			"*": "deny",
			minecraft: "allow",
		});
	});

	test("shell workspace 無効時は OpenCode Skills を全拒否する", () => {
		const { opencode } = createConversationProfile({
			providerId: "provider",
			modelId: "model",
			mcpServers: {},
		});

		expect(opencode.builtinTools.skill).toBe(false);
		expect(opencode.skillPermission).toEqual({ "*": "deny" });
		expect(opencode.opencodeAgents).toBeUndefined();
	});

	test("Minecraft 有効時は minecraft skill だけを primary agent に許可する", () => {
		const { opencode } = createConversationProfile({
			providerId: "provider",
			modelId: "model",
			mcpServers: {},
			minecraftEnabled: true,
		});

		expect(opencode.builtinTools.skill).toBe(true);
		expect(opencode.skillPermission).toEqual({
			"*": "deny",
			minecraft: "allow",
		});
		expect(opencode.opencodeAgents).toBeUndefined();
	});

	test("shell workspace と Minecraft の併用時は build agent に delegate-to-shell-worker / self-update / minecraft skill だけを許可する", () => {
		const { opencode } = createConversationProfile({
			providerId: "provider",
			modelId: "model",
			mcpServers: {},
			minecraftEnabled: true,
			shellWorkspaceSubagent: {
				providerId: "worker-provider",
				modelId: "worker-model",
			},
		});

		const build = opencode.opencodeAgents?.build as
			| { tools?: Record<string, boolean>; permission?: Record<string, unknown> }
			| undefined;
		const worker = opencode.opencodeAgents?.["shell-worker"] as
			| { tools?: Record<string, boolean>; permission?: Record<string, unknown> }
			| undefined;

		expect(opencode.primaryTools).toEqual(["task", "skill"]);
		expect(build?.tools?.skill).toBe(true);
		expect(build?.permission?.skill).toEqual({
			"*": "deny",
			"delegate-to-shell-worker": "allow",
			"self-update": "allow",
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
