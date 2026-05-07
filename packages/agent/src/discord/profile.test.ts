import { describe, expect, test } from "bun:test";

import { createConversationProfile, SHELL_WORKSPACE_AGENT_NAME } from "./profile.ts";

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

describe("createConversationProfile shell workspace subagent", () => {
	test("shell workspace 有効時は task を開き shell-worker agent を定義する", () => {
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

		expect(profile.builtinTools.task).toBe(true);
		expect(profile.defaultAgent).toBe("build");
		expect(profile.primaryTools).toEqual(["task"]);
		expect(profile.pollingPrompt).toContain(SHELL_WORKSPACE_AGENT_NAME);

		const worker = profile.opencodeAgents?.[SHELL_WORKSPACE_AGENT_NAME];
		expect(worker?.mode).toBe("subagent");
		expect(worker?.model).toBe("worker-provider/worker-model");
		expect(worker?.temperature).toBe(0.4);
		expect(worker?.steps).toBe(12);
		const workerTools = (worker as { tools?: Record<string, boolean> } | undefined)?.tools;
		expect(workerTools?.shell_exec).toBe(true);
		expect(workerTools?.bash).toBe(false);
	});

	test("shell workspace 無効時は task と subagent 設定を追加しない", () => {
		const profile = createConversationProfile({
			providerId: "provider",
			modelId: "model",
			mcpServers: {},
		});

		expect(profile.builtinTools.task).toBe(false);
		expect(profile.opencodeAgents).toBeUndefined();
		expect(profile.defaultAgent).toBeUndefined();
		expect(profile.primaryTools).toBeUndefined();
	});
});
