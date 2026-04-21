import { describe, expect, test } from "bun:test";

import { createConversationProfile } from "@vicissitude/agent/discord/profile";

describe("createConversationProfile", () => {
	test("pollingPrompt が Discord bot の応答指示を含む", () => {
		const profile = createConversationProfile({
			providerId: "provider",
			modelId: "model",
			mcpServers: {},
		});

		expect(profile.pollingPrompt).toContain("Discord bot");
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
