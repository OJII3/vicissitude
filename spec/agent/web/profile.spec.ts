import { describe, expect, test } from "bun:test";

import { createWebConversationProfile } from "@vicissitude/agent/web/profile";

describe("createWebConversationProfile", () => {
	test("同一人格の Web 応答用 profile を作る", () => {
		const profile = createWebConversationProfile({
			providerId: "provider",
			modelId: "model",
			mcpServers: {
				core: { type: "local", command: ["bun", "core"] },
			},
		});

		expect(profile.name).toBe("web-conversation");
		expect(profile.model).toEqual({ providerId: "provider", modelId: "model" });
		expect(profile.mcpServers).toEqual({
			core: { type: "local", command: ["bun", "core"] },
		});
		expect(profile.builtinTools.webfetch).toBe(true);
		expect(profile.builtinTools.bash).toBe(false);
		expect(profile.builtinTools.skill).toBe(false);
		expect(profile.skillPermission).toEqual({ "*": "deny" });
		expect(profile.pollingPrompt).toContain("最終テキストは Web UI に表示されます");
		expect(profile.pollingPrompt).not.toContain("discord_send_message");
		expect(profile.pollingPrompt).not.toContain("discord_reply");
	});
});
