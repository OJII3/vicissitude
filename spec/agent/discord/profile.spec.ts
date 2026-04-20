import { describe, expect, test } from "bun:test";

import { createConversationProfile } from "@vicissitude/agent/discord/profile";

describe("createConversationProfile", () => {
	test("Discord runner は新着イベント待ちで再起動する", () => {
		const profile = createConversationProfile({
			providerId: "provider",
			modelId: "model",
			mcpServers: {},
		});

		expect(profile.restartPolicy).toBe("wait_for_events");
	});

	test("pollingPrompt に core_wait_for_events ツール名が含まれる", () => {
		const profile = createConversationProfile({
			providerId: "provider",
			modelId: "model",
			mcpServers: {},
		});

		expect(profile.pollingPrompt).toContain("core_wait_for_events");
	});

	test("pollingPrompt に core_wait_for_events の単独呼び出し制約が含まれる", () => {
		const profile = createConversationProfile({
			providerId: "provider",
			modelId: "model",
			mcpServers: {},
		});

		expect(profile.pollingPrompt).toContain("単独で呼ぶこと");
	});
});
