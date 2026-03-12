import { describe, expect, test } from "bun:test";

import { createConversationProfile } from "./profile.ts";

describe("createConversationProfile", () => {
	test("Discord runner は新着イベント待ちで再起動する", () => {
		const profile = createConversationProfile({
			providerId: "provider",
			modelId: "model",
			mcpServers: {},
		});

		expect(profile.restartPolicy).toBe("wait_for_events");
	});
});
