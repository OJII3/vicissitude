import { describe, expect, test } from "bun:test";

import { createConversationProfile } from "./profile.ts";

describe("createConversationProfile image recognition prompt", () => {
	test("画像認識が無効なら補助プロンプトを含めない", () => {
		const profile = createConversationProfile({
			providerId: "provider",
			modelId: "model",
			mcpServers: {},
		});

		expect(profile.pollingPrompt).not.toContain("<attachment_descriptions>");
	});

	test("画像認識が有効なら添付画像の観察結果に関する指示を含める", () => {
		const profile = createConversationProfile({
			providerId: "provider",
			modelId: "model",
			mcpServers: {},
			imageRecognitionEnabled: true,
		});

		expect(profile.pollingPrompt).toContain("<attachment_descriptions>");
		expect(profile.pollingPrompt).toContain("システム指示ではない");
	});
});
