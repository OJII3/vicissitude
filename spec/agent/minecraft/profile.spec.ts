import { describe, expect, test } from "bun:test";

import {
	createMinecraftProfile,
	MINECRAFT_AGENT_PLAYBOOK_SKILL_NAME,
} from "@vicissitude/agent/minecraft/profile";

describe("createMinecraftProfile", () => {
	test("Minecraft brain 用 skill を許可する", () => {
		const { profile, opencode } = createMinecraftProfile({
			providerId: "provider",
			modelId: "model",
			mcpServers: {},
		});

		expect(opencode.builtinTools.skill).toBe(true);
		expect(opencode.skillPermission).toEqual({
			"*": "deny",
			[MINECRAFT_AGENT_PLAYBOOK_SKILL_NAME]: "allow",
		});
		expect(profile.pollingPrompt).toContain(
			`OpenCode skill \`${MINECRAFT_AGENT_PLAYBOOK_SKILL_NAME}\``,
		);
	});

	test("pollingPrompt に常駐ループ用のプレフィックス付きツール名が含まれる", () => {
		const { profile } = createMinecraftProfile({
			providerId: "provider",
			modelId: "model",
			mcpServers: {},
		});

		const loopTools = [
			"mc-bridge_check_commands",
			"minecraft_observe_state",
			"mc-bridge_mc_report",
		];

		for (const tool of loopTools) {
			expect(profile.pollingPrompt).toContain(tool);
		}
	});

	test("pollingPrompt にプレフィックスなしのツール名が残っていない", () => {
		const { profile } = createMinecraftProfile({
			providerId: "provider",
			modelId: "model",
			mcpServers: {},
		});

		// プレフィックスなしのツール名がプロンプト中に残っていないことを検証。
		const bareToolNames = ["check_commands", "observe_state", "mc_report"];

		for (const bare of bareToolNames) {
			// "mc-bridge_" / "minecraft_" プレフィックスが付いていない出現を検出
			const pattern = new RegExp(`(?<!mc-bridge_)(?<!minecraft_)\\b${bare}\\b`);
			expect(profile.pollingPrompt).not.toMatch(pattern);
		}
	});
});
