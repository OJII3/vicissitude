import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import os from "os";
import { join } from "path";

import { createMockLogger } from "@vicissitude/shared/test-helpers";

import {
	createContextLayer,
	createDiscordAgents,
	createWebContextLayer,
	createWebConversationAgent,
	createStoreLayer,
	createMetrics,
} from "./bootstrap.ts";
import type { AppConfig } from "./config.ts";

function createTestConfig(overrides?: Partial<AppConfig>): AppConfig {
	return {
		discordToken: "test-token",
		webPort: 4000,
		gatewayPort: 4001,
		opencode: {
			providerId: "test-provider",
			modelId: "test-model",
			basePort: 4096,
			sessionMaxAgeHours: 48,
			temperature: 1.0,
		},
		heartbeatOpencode: {
			providerId: "test-heartbeat-provider",
			modelId: "test-heartbeat-model",
			temperature: 0.3,
		},
		memory: {
			providerId: "test-provider",
			modelId: "test-model",
			ollamaBaseUrl: "http://localhost:11434",
			embeddingModel: "test-embedding",
		},
		mcBrain: {
			providerId: "test-provider",
			modelId: "test-model",
			temperature: 0.7,
		},
		dataDir: "/tmp/vicissitude-bootstrap-test",
		contextDir: "/tmp/test-context",
		...overrides,
	};
}

function createContextRoot(): string {
	const root = mkdtempSync(join(os.tmpdir(), "vicissitude-context-root-"));
	const contextDir = join(root, "context");
	mkdirSync(contextDir, { recursive: true });
	writeFileSync(join(contextDir, "TOOLS-DISCORD.md"), "discord tools");
	writeFileSync(join(contextDir, "TOOLS-CORE.md"), "core tools");
	writeFileSync(join(contextDir, "TOOLS-CODE.md"), "shell tools");
	writeFileSync(join(contextDir, "TOOLS-MINECRAFT.md"), "minecraft tools");
	return root;
}

describe("createStoreLayer", () => {
	test("DB と SessionStore を返す", () => {
		const config = createTestConfig();
		const { db, sessionStore } = createStoreLayer(config);

		expect(db).toBeDefined();
		expect(sessionStore.count()).toBe(0);
	});
});

describe("createMetrics", () => {
	test("collector と server を返す", () => {
		const logger = createMockLogger();
		const { collector, server } = createMetrics(logger, 0);

		expect(collector).toBeDefined();
		expect(server).toBeDefined();
	});
});

describe("createContextLayer", () => {
	test("デフォルトでは capability 連動ツール説明を除外する", async () => {
		const root = createContextRoot();
		const { contextBuilder } = createContextLayer(createTestConfig(), root);
		const context = await contextBuilder.build();

		expect(context).toContain("core tools");
		expect(context).toContain("discord tools");
		expect(context).not.toContain("shell tools");
		expect(context).not.toContain("minecraft tools");
	});

	test("shellWorkspace 有効時は TOOLS-CODE を注入する", async () => {
		const root = createContextRoot();
		const { contextBuilder } = createContextLayer(
			createTestConfig({
				shellWorkspace: {
					enabled: true,
					image: "sandbox",
					agent: {
						providerId: "shell-provider",
						modelId: "shell-model",
						temperature: 0.4,
						steps: 16,
					},
					dataDir: "/tmp/shell-workspaces",
					auditLogPath: "/tmp/shell-audit.jsonl",
					networkProfile: "open",
					defaultTtlMinutes: 60,
					maxTtlMinutes: 120,
					defaultTimeoutSeconds: 30,
					maxTimeoutSeconds: 120,
					maxOutputChars: 50_000,
				},
			}),
			root,
		);
		const context = await contextBuilder.build();

		expect(context).toContain("core tools");
		expect(context).toContain("discord tools");
		expect(context).toContain("shell tools");
		expect(context).not.toContain("minecraft tools");
	});

	test("Web context は人格と core tools を残し Discord 固有コンテキストを除外する", async () => {
		const root = createContextRoot();
		const contextDir = join(root, "context");
		writeFileSync(join(contextDir, "IDENTITY.md"), "identity");
		writeFileSync(join(contextDir, "DISCORD.md"), "discord rules");
		writeFileSync(join(contextDir, "HEARTBEAT.md"), "heartbeat rules");
		const { contextBuilder } = createWebContextLayer(createTestConfig(), root);
		const context = await contextBuilder.build("web:local");

		expect(context).toContain("identity");
		expect(context).toContain("core tools");
		expect(context).not.toContain("discord rules");
		expect(context).not.toContain("heartbeat rules");
		expect(context).not.toContain("discord tools");
		expect(context).not.toContain("shell tools");
		expect(context).not.toContain("minecraft tools");
	});
});

describe("createDiscordAgents", () => {
	test("Discord guild agent に core と discord MCP を渡す", () => {
		const config = createTestConfig();
		const { db, sessionStore } = createStoreLayer(config);
		const agents = createDiscordAgents(
			config,
			[{ agentId: "discord:123456789", scopeId: "discord:guild:123456789" }],
			{
				db,
				sessionStore,
				contextBuilder: { build: () => Promise.resolve("context") },
				logger: createMockLogger(),
				appRoot: "/app",
				coreEnvironment: { DATA_DIR: "/data/core" },
				discordEnvironment: { DISCORD_TOKEN: "token", DATA_DIR: "/data/discord" },
			},
		);
		const agent = agents.get("discord:guild:123456789") as unknown as {
			profile: {
				mcpServers: Record<string, { type: string; environment?: Record<string, string> }>;
				skillPermission: Record<string, string>;
			};
			sessionPort: { config: { skillPaths?: string[] } };
		};

		expect(Object.keys(agent.profile.mcpServers).toSorted()).toEqual(["core", "discord"]);
		expect(agent.profile.mcpServers.core?.environment?.AGENT_ID).toBe("discord:123456789");
		expect(agent.profile.mcpServers.discord?.environment?.AGENT_ID).toBe("discord:123456789");
		expect(agent.profile.mcpServers.discord?.environment?.DISCORD_TOKEN).toBe("token");
		expect(agent.profile.skillPermission).toEqual({ "*": "deny" });
		expect(agent.sessionPort.config.skillPaths).toEqual(["/app/.agents/skills"]);
	});

	test("Discord DM agent は DM scopeId と agentId で作成される", () => {
		const config = createTestConfig();
		const { db, sessionStore } = createStoreLayer(config);
		const agents = createDiscordAgents(
			config,
			[{ agentId: "discord:dm:999888777", scopeId: "discord:dm:999888777" }],
			{
				db,
				sessionStore,
				contextBuilder: { build: () => Promise.resolve("context") },
				logger: createMockLogger(),
				appRoot: "/app",
				coreEnvironment: { DATA_DIR: "/data/core" },
				discordEnvironment: { DISCORD_TOKEN: "token", DATA_DIR: "/data/discord" },
			},
		);
		const agent = agents.get("discord:dm:999888777") as unknown as {
			profile: {
				mcpServers: Record<string, { environment?: Record<string, string> }>;
			};
		};

		expect(agent.profile.mcpServers.core?.environment?.AGENT_ID).toBe("discord:dm:999888777");
		expect(agent.profile.mcpServers.discord?.environment?.AGENT_ID).toBe("discord:dm:999888777");
	});

	test("heartbeat agent は shellWorkspace 有効時でも deps の OpenCode 設定だけを使う", () => {
		const config = createTestConfig({
			shellWorkspace: {
				enabled: true,
				image: "sandbox",
				agent: {
					providerId: "shell-provider",
					modelId: "shell-model",
					temperature: 0.4,
					steps: 16,
				},
				backgroundSubagents: true,
				dataDir: "/tmp/shell-workspaces",
				auditLogPath: "/tmp/shell-audit.jsonl",
				networkProfile: "open",
				defaultTtlMinutes: 60,
				maxTtlMinutes: 120,
				defaultTimeoutSeconds: 30,
				maxTimeoutSeconds: 120,
				maxOutputChars: 50_000,
			},
		});
		const { db, sessionStore } = createStoreLayer(config);
		const agents = createDiscordAgents(
			config,
			[{ agentId: "discord:heartbeat:123456789", scopeId: "discord:guild:123456789" }],
			{
				db,
				sessionStore,
				contextBuilder: { build: () => Promise.resolve("context") },
				logger: createMockLogger(),
				appRoot: "/app",
				coreEnvironment: {},
				discordEnvironment: {},
				opencode: {
					providerId: "heartbeat-provider",
					modelId: "heartbeat-model",
					temperature: 0.2,
				},
			},
		);
		const agent = agents.get("discord:guild:123456789") as unknown as {
			profile: {
				model: { providerId: string; modelId: string };
				builtinTools: Record<string, boolean>;
				skillPermission: Record<string, string>;
				opencodeAgents?: unknown;
			};
			sessionPort: {
				config: {
					temperature?: number;
					skillPaths?: string[];
					directory?: string;
					environment?: Record<string, string>;
				};
			};
		};

		expect(agent.profile.model).toEqual({
			providerId: "heartbeat-provider",
			modelId: "heartbeat-model",
		});
		expect(agent.sessionPort.config.temperature).toBe(0.2);
		expect(agent.profile.builtinTools.skill).toBe(false);
		expect(agent.profile.builtinTools.bash).toBe(false);
		expect(agent.profile.builtinTools.task).toBe(false);
		expect(agent.profile.skillPermission).toEqual({ "*": "deny" });
		expect(agent.profile.opencodeAgents).toBeUndefined();
		expect(agent.sessionPort.config.skillPaths).toEqual(["/app/.agents/skills"]);
		expect(agent.sessionPort.config.directory).toBeUndefined();
		expect(agent.sessionPort.config.environment).toBeUndefined();
	});

	test("shellWorkspace の GitHub token は Git credential helper 付きで OpenCode に渡す", () => {
		const config = createTestConfig({
			shellWorkspace: {
				enabled: true,
				image: "sandbox",
				agent: {
					providerId: "shell-provider",
					modelId: "shell-model",
					temperature: 0.4,
					steps: 16,
				},
				environment: {
					GH_TOKEN: "github-token",
					GITHUB_TOKEN: "github-token",
				},
				dataDir: "/tmp/shell-workspaces",
				auditLogPath: "/tmp/shell-audit.jsonl",
				networkProfile: "open",
				defaultTtlMinutes: 60,
				maxTtlMinutes: 120,
				defaultTimeoutSeconds: 30,
				maxTimeoutSeconds: 120,
				maxOutputChars: 50_000,
			},
		});
		const { db, sessionStore } = createStoreLayer(config);
		const agents = createDiscordAgents(
			config,
			[{ agentId: "discord:123456789", scopeId: "discord:guild:123456789" }],
			{
				db,
				sessionStore,
				contextBuilder: { build: () => Promise.resolve("context") },
				logger: createMockLogger(),
				appRoot: "/app",
				coreEnvironment: {},
				discordEnvironment: {},
			},
		);
		const agent = agents.get("discord:guild:123456789") as unknown as {
			sessionPort: { config: { environment?: Record<string, string> } };
		};

		expect(agent.sessionPort.config.environment?.GH_TOKEN).toBe("github-token");
		expect(agent.sessionPort.config.environment?.GIT_CONFIG_COUNT).toBe("1");
		expect(agent.sessionPort.config.environment?.GIT_CONFIG_KEY_0).toBe(
			"credential.https://github.com.helper",
		);
		expect(agent.sessionPort.config.environment?.GIT_CONFIG_VALUE_0).toContain("GH_TOKEN");
		expect(agent.sessionPort.config.environment?.GIT_CONFIG_VALUE_0).not.toContain("github-token");
	});

	test("shellWorkspace の Git identity は workspace 内の gitconfig として渡す", () => {
		const dataDir = mkdtempSync(join(os.tmpdir(), "vicissitude-shell-workspace-"));
		const config = createTestConfig({
			shellWorkspace: {
				enabled: true,
				image: "sandbox",
				agent: {
					providerId: "shell-provider",
					modelId: "shell-model",
					temperature: 0.4,
					steps: 16,
				},
				git: {
					userName: "ふあ",
					userEmail: "282728168+agenthua@users.noreply.github.com",
				},
				dataDir,
				auditLogPath: "/tmp/shell-audit.jsonl",
				networkProfile: "open",
				defaultTtlMinutes: 60,
				maxTtlMinutes: 120,
				defaultTimeoutSeconds: 30,
				maxTimeoutSeconds: 120,
				maxOutputChars: 50_000,
			},
		});
		const { db, sessionStore } = createStoreLayer(config);
		const agents = createDiscordAgents(
			config,
			[{ agentId: "discord:123456789", scopeId: "discord:guild:123456789" }],
			{
				db,
				sessionStore,
				contextBuilder: { build: () => Promise.resolve("context") },
				logger: createMockLogger(),
				appRoot: "/app",
				coreEnvironment: {},
				discordEnvironment: {},
			},
		);
		const agent = agents.get("discord:guild:123456789") as unknown as {
			sessionPort: { config: { environment?: Record<string, string> } };
		};
		const gitConfigPath = join(
			dataDir,
			"opencode",
			"discord_123456789",
			".config",
			"git",
			"config",
		);
		const gitConfig = readFileSync(gitConfigPath, "utf8");

		expect(agent.sessionPort.config.environment?.GIT_CONFIG_GLOBAL).toBe(gitConfigPath);
		expect(gitConfig).toContain('name = "ふあ"');
		expect(gitConfig).toContain('email = "282728168+agenthua@users.noreply.github.com"');
		expect(gitConfig).toContain('[credential "https://github.com"]');
	});

	test("backgroundSubagents 有効時は OpenCode 実験フラグを渡す", () => {
		const config = createTestConfig({
			shellWorkspace: {
				enabled: true,
				image: "sandbox",
				agent: {
					providerId: "shell-provider",
					modelId: "shell-model",
					temperature: 0.4,
					steps: 16,
				},
				backgroundSubagents: true,
				dataDir: "/tmp/shell-workspaces",
				auditLogPath: "/tmp/shell-audit.jsonl",
				networkProfile: "open",
				defaultTtlMinutes: 60,
				maxTtlMinutes: 120,
				defaultTimeoutSeconds: 30,
				maxTimeoutSeconds: 120,
				maxOutputChars: 50_000,
			},
		});
		const { db, sessionStore } = createStoreLayer(config);
		const agents = createDiscordAgents(
			config,
			[{ agentId: "discord:123456789", scopeId: "discord:guild:123456789" }],
			{
				db,
				sessionStore,
				contextBuilder: { build: () => Promise.resolve("context") },
				logger: createMockLogger(),
				appRoot: "/app",
				coreEnvironment: {},
				discordEnvironment: {},
			},
		);
		const agent = agents.get("discord:guild:123456789") as unknown as {
			profile: {
				primaryTools?: string[];
				builtinTools: Record<string, boolean>;
				opencodeAgents?: Record<string, { tools?: Record<string, boolean>; permission?: unknown }>;
			};
			sessionPort: { config: { environment?: Record<string, string> } };
		};

		expect(agent.profile.builtinTools.skill).toBe(true);
		expect(agent.profile.builtinTools.task_status).toBe(true);
		expect(agent.profile.primaryTools).toEqual(["task", "task_status"]);
		expect(agent.profile.opencodeAgents?.build?.tools?.skill).toBe(false);
		expect(agent.profile.opencodeAgents?.["shell-worker"]?.tools?.skill).toBe(true);
		expect(agent.sessionPort.config.environment?.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS).toBe(
			"true",
		);
	});
});

describe("createWebConversationAgent", () => {
	test("Web agent は core MCP のみを持ち AGENT_ID を web:local にする", () => {
		const config = createTestConfig();
		const { sessionStore } = createStoreLayer(config);
		const agent = createWebConversationAgent(config, {
			sessionStore,
			contextBuilder: { build: () => Promise.resolve("context") },
			logger: createMockLogger(),
			appRoot: "/app",
			coreEnvironment: { DATA_DIR: "/data/core" },
			opencodePort: 4103,
		}) as unknown as {
			profile: {
				mcpServers: Record<string, { type: string; environment?: Record<string, string> }>;
				builtinTools: Record<string, boolean>;
				skillPermission: Record<string, string>;
			};
			sessionPort: { config: { port: number; skillPaths?: string[] } };
		};

		expect(Object.keys(agent.profile.mcpServers)).toEqual(["core"]);
		expect(agent.profile.mcpServers.core?.environment?.AGENT_ID).toBe("web:local");
		expect(agent.profile.builtinTools.skill).toBe(false);
		expect(agent.profile.skillPermission).toEqual({ "*": "deny" });
		expect(agent.sessionPort.config.port).toBe(4103);
		expect(agent.sessionPort.config.skillPaths).toEqual(["/app/.agents/skills"]);
	});
});
