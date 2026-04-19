import { describe, expect, test } from "bun:test";

import { createMinecraftProfile } from "@vicissitude/agent/minecraft/profile";

describe("createMinecraftProfile", () => {
	test("pollingPrompt に mc-bridge_ プレフィックス付きツール名が含まれる", () => {
		const profile = createMinecraftProfile({
			providerId: "provider",
			modelId: "model",
			mcpServers: {},
		});

		const tools = [
			"mc-bridge_check_commands",
			"mc-bridge_observe_state",
			"mc-bridge_mc_report",
			"mc-bridge_mc_read_goals",
			"mc-bridge_mc_update_goals",
			"mc-bridge_mc_read_progress",
			"mc-bridge_mc_update_progress",
			"mc-bridge_mc_record_skill",
			"mc-bridge_mc_read_skills",
			"mc-bridge_sleep_in_bed",
			"mc-bridge_find_shelter",
			"mc-bridge_eat_food",
		];

		for (const tool of tools) {
			expect(profile.pollingPrompt).toContain(tool);
		}
	});

	test("pollingPrompt にプレフィックスなしのツール名が残っていない", () => {
		const profile = createMinecraftProfile({
			providerId: "provider",
			modelId: "model",
			mcpServers: {},
		});

		// プレフィックスなしのツール名がプロンプト中に残っていないことを検証。
		// "mc-bridge_check_commands" を含むがベアな "check_commands" は含まない、
		// という条件を正規表現で検証する。
		const bareToolNames = [
			"check_commands",
			"observe_state",
			"sleep_in_bed",
			"find_shelter",
			"eat_food",
		];

		for (const bare of bareToolNames) {
			// "mc-bridge_" プレフィックスが付いていない出現を検出
			const pattern = new RegExp(`(?<!mc-bridge_)\\b${bare}\\b`);
			expect(profile.pollingPrompt).not.toMatch(pattern);
		}
	});
});
