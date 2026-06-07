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
			},
		});

		expect(profile.builtinTools.task).toBe(true);
		expect(profile.builtinTools.bash).toBe(true);
		expect(profile.builtinTools.read).toBe(true);
		expect(profile.builtinTools.write).toBe(true);
		expect(profile.builtinTools.skill).toBe(true);
		expect(profile.builtinTools.task_status).toBe(false);
		expect(profile.skillPermission).toEqual({
			"*": "deny",
			"delegate-to-shell-worker": "allow",
			"self-update": "allow",
		});
		expect(profile.defaultAgent).toBe("build");
		expect(profile.primaryTools).toEqual(["task", "skill"]);
		expect(profile.pollingPrompt).toContain(SHELL_WORKSPACE_AGENT_NAME);
		expect(profile.pollingPrompt).toContain("OpenCode skill `delegate-to-shell-worker`");
		expect(profile.pollingPrompt).not.toContain("background=true");

		const build = profile.opencodeAgents?.build;
		const buildTools = (build as { tools?: Record<string, boolean> } | undefined)?.tools;
		expect(buildTools?.read).toBe(false);
		expect(buildTools?.write).toBe(false);
		expect(buildTools?.skill).toBe(true);
		const buildPermission = (build as { permission?: Record<string, unknown> } | undefined)
			?.permission;
		expect(buildPermission?.skill).toEqual({
			"*": "deny",
			"delegate-to-shell-worker": "allow",
			"self-update": "allow",
		});

		const worker = profile.opencodeAgents?.[SHELL_WORKSPACE_AGENT_NAME];
		expect(worker?.mode).toBe("subagent");
		expect(worker?.model).toBe("worker-provider/worker-model");
		const workerTools = (worker as { tools?: Record<string, boolean> } | undefined)?.tools;
		expect(workerTools?.bash).toBe(true);
		expect(workerTools?.read).toBe(true);
		expect(workerTools?.write).toBe(true);
		expect(workerTools?.skill).toBe(true);
		expect(workerTools?.task).toBe(false);
		const workerPermission = (worker as { permission?: Record<string, unknown> } | undefined)
			?.permission;
		expect(workerPermission?.skill).toEqual({
			"*": "deny",
			debug: "allow",
			"skill-creator": "allow",
		});
		expect(workerPermission?.bash).toBe("allow");
		expect(workerPermission?.read).toBe("allow");
		expect(workerPermission?.edit).toBe("allow");
		expect(workerPermission?.task).toBe("deny");
		expect(workerPermission?.external_directory).toBe("deny");
		expect(workerPermission).toMatchObject({
			"*_*": "deny",
			"core_*": "deny",
			"discord_*": "deny",
			"mc-bridge_*": "deny",
			"minecraft_*": "deny",
			"shell-workspace_*": "deny",
		});
		expect(worker?.prompt).toContain("Return results to the primary agent");
	});

	test("background subagent 有効時は task_status を開き background 指示を含める", () => {
		const profile = createConversationProfile({
			providerId: "provider",
			modelId: "model",
			mcpServers: {},
			shellWorkspaceSubagent: {
				providerId: "worker-provider",
				modelId: "worker-model",
			},
			shellWorkspaceBackgroundSubagents: true,
		});

		expect(profile.builtinTools.task).toBe(true);
		expect(profile.builtinTools.task_status).toBe(true);
		expect(profile.primaryTools).toEqual(["task", "task_status", "skill"]);
		expect(profile.pollingPrompt).toContain("background=true");
		expect(profile.pollingPrompt).toContain("task_status(task_id=..., wait=false)");

		const build = profile.opencodeAgents?.build;
		const buildPermission = (build as { permission?: Record<string, string> } | undefined)
			?.permission;
		expect(buildPermission?.task_status).toBe("allow");

		const worker = profile.opencodeAgents?.[SHELL_WORKSPACE_AGENT_NAME];
		const workerTools = (worker as { tools?: Record<string, boolean> } | undefined)?.tools;
		expect(workerTools?.task_status).toBe(false);
	});

	test("shell workspace 無効時は task と subagent 設定を追加しない", () => {
		const profile = createConversationProfile({
			providerId: "provider",
			modelId: "model",
			mcpServers: {},
		});

		expect(profile.builtinTools.task).toBe(false);
		expect(profile.builtinTools.task_status).toBe(false);
		expect(profile.builtinTools.bash).toBe(false);
		expect(profile.builtinTools.skill).toBe(false);
		expect(profile.skillPermission).toEqual({ "*": "deny" });
		expect(profile.opencodeAgents).toBeUndefined();
		expect(profile.defaultAgent).toBeUndefined();
		expect(profile.primaryTools).toBeUndefined();
	});

	test("Minecraft 有効時は primary agent で minecraft skill を使える", () => {
		const profile = createConversationProfile({
			providerId: "provider",
			modelId: "model",
			mcpServers: {},
			minecraftEnabled: true,
		});

		expect(profile.builtinTools.skill).toBe(true);
		expect(profile.skillPermission).toEqual({
			"*": "deny",
			minecraft: "allow",
		});
		expect(profile.opencodeAgents).toBeUndefined();
		expect(profile.primaryTools).toBeUndefined();
	});

	test("shell workspace と Minecraft の併用時は primary_tools に skill を追加する", () => {
		const profile = createConversationProfile({
			providerId: "provider",
			modelId: "model",
			mcpServers: {},
			minecraftEnabled: true,
			shellWorkspaceSubagent: {
				providerId: "worker-provider",
				modelId: "worker-model",
			},
			shellWorkspaceBackgroundSubagents: true,
		});

		expect(profile.primaryTools).toEqual(["task", "task_status", "skill"]);

		const build = profile.opencodeAgents?.build;
		const buildTools = (build as { tools?: Record<string, boolean> } | undefined)?.tools;
		const buildPermission = (build as { permission?: Record<string, unknown> } | undefined)
			?.permission;

		expect(buildTools?.skill).toBe(true);
		expect(buildPermission?.skill).toEqual({
			"*": "deny",
			"delegate-to-shell-worker": "allow",
			"self-update": "allow",
			minecraft: "allow",
		});
		const worker = profile.opencodeAgents?.[SHELL_WORKSPACE_AGENT_NAME];
		const workerPermission = (worker as { permission?: Record<string, unknown> } | undefined)
			?.permission;
		expect(workerPermission).toMatchObject({
			"*_*": "deny",
			"discord_*": "deny",
			"minecraft_*": "deny",
		});
	});
});
