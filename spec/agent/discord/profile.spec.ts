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
});
