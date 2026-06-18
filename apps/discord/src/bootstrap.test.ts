/* oxlint-disable max-lines, max-lines-per-function -- bootstrap の DI 結合テストはケース数に応じて長くなるため許容 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync } from "fs";
import os from "os";
import { join } from "path";

import { createMockLogger } from "@vicissitude/shared/test-helpers";
import type { DueReminder } from "@vicissitude/shared/types";

import {
	buildEmailCheckPreFilter,
	createDiscordAgents,
	createWebConversationAgent,
	createMetrics,
	resolveBootstrapRoot,
} from "./bootstrap.ts";
import { createStoreLayer } from "./bootstrap/layers.ts";
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

describe("createMetrics", () => {
	test("collector と server を返す", () => {
		const logger = createMockLogger();
		const { collector, server } = createMetrics(logger, 0);

		expect(collector).toBeDefined();
		expect(server).toBeDefined();
	});
});

describe("resolveBootstrapRoot", () => {
	test("APP_ROOT があればそれを優先する", () => {
		const root = resolveBootstrapRoot(createTestConfig(), {
			APP_ROOT: "/tmp/from-env",
		} as NodeJS.ProcessEnv);

		expect(root).toBe("/tmp/from-env");
	});

	test("APP_ROOT がなければ contextDir の親を使う", () => {
		const root = resolveBootstrapRoot(
			createTestConfig({
				contextDir: "/tmp/vicissitude-root/context",
			}),
			{} as NodeJS.ProcessEnv,
		);

		expect(root).toBe("/tmp/vicissitude-root");
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
		expect(agent.sessionPort.config.skillPaths).toEqual(["/app/context/skills/discord"]);
	});

	test("Minecraft 有効時は Discord agent に minecraft skill を許可する", () => {
		const config = createTestConfig({
			minecraft: {
				host: "localhost",
				port: 25565,
				username: "hua",
				authMode: "offline",
				mcpPort: 3001,
				viewerPort: 3007,
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
				discordEnvironment: { DISCORD_TOKEN: "token", DATA_DIR: "/data/discord" },
			},
		);
		const agent = agents.get("discord:guild:123456789") as unknown as {
			profile: {
				builtinTools: Record<string, boolean>;
				skillPermission: Record<string, string>;
			};
			sessionPort: { config: { skillPaths?: string[] } };
		};

		expect(agent.profile.builtinTools.skill).toBe(true);
		expect(agent.profile.skillPermission).toEqual({
			"*": "deny",
			minecraft: "allow",
		});
		expect(agent.sessionPort.config.skillPaths).toEqual(["/app/context/skills/discord"]);
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
			shellAgent: {
				enabled: true,
				agent: {
					providerId: "shell-provider",
					modelId: "shell-model",
				},
				backgroundSubagents: true,
				dataDir: "/tmp/shell-workspaces",
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
		expect(agent.sessionPort.config.skillPaths).toEqual(["/app/context/skills/discord"]);
		expect(agent.sessionPort.config.directory).toBeUndefined();
		expect(agent.sessionPort.config.environment).toBeUndefined();
	});

	test("Minecraft 有効時は heartbeat agent でも minecraft skill を許可する", () => {
		const config = createTestConfig({
			minecraft: {
				host: "localhost",
				port: 25565,
				username: "hua",
				authMode: "offline",
				mcpPort: 3001,
				viewerPort: 3007,
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
				builtinTools: Record<string, boolean>;
				skillPermission: Record<string, string>;
				opencodeAgents?: unknown;
			};
		};

		expect(agent.profile.builtinTools.skill).toBe(true);
		expect(agent.profile.skillPermission).toEqual({
			"*": "deny",
			minecraft: "allow",
		});
		expect(agent.profile.opencodeAgents).toBeUndefined();
	});

	test("shellWorkspace の GitHub token は Git credential helper 付きで OpenCode に渡す", () => {
		const config = createTestConfig({
			shellAgent: {
				enabled: true,
				agent: {
					providerId: "shell-provider",
					modelId: "shell-model",
				},
				environment: {
					GH_TOKEN: "github-token",
					GITHUB_TOKEN: "github-token",
				},
				dataDir: "/tmp/shell-workspaces",
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
			shellAgent: {
				enabled: true,
				agent: {
					providerId: "shell-provider",
					modelId: "shell-model",
				},
				git: {
					userName: "ふあ",
					userEmail: "282728168+agenthua@users.noreply.github.com",
				},
				dataDir,
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
			shellAgent: {
				enabled: true,
				agent: {
					providerId: "shell-provider",
					modelId: "shell-model",
				},
				backgroundSubagents: true,
				dataDir: "/tmp/shell-workspaces",
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
			sessionPort: { config: { environment?: Record<string, string>; skillPaths?: string[] } };
		};

		expect(agent.profile.builtinTools.skill).toBe(true);
		expect(agent.profile.builtinTools.task_status).toBe(true);
		expect(agent.profile.primaryTools).toEqual(["task", "task_status", "skill"]);
		expect(agent.profile.opencodeAgents?.build?.tools?.skill).toBe(true);
		expect(agent.profile.opencodeAgents?.build?.permission).toMatchObject({
			skill: { "*": "deny", "delegate-to-shell-worker": "allow", "self-update": "allow" },
		});
		expect(agent.profile.opencodeAgents?.["shell-worker"]?.tools?.skill).toBe(true);
		expect(agent.profile.opencodeAgents?.["shell-worker"]?.permission).toMatchObject({
			"*_*": "deny",
			"core_*": "deny",
			"discord_*": "deny",
			"mc-bridge_*": "deny",
			"minecraft_*": "deny",
		});
		expect(agent.sessionPort.config.skillPaths).toEqual([
			"/app/context/skills/discord",
			"/app/context/skills/shell-worker",
		]);
		expect(agent.sessionPort.config.environment?.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS).toBe(
			"true",
		);
	});

	test("shellWorkspace と Minecraft 併用時は primary agent に delegate-to-shell-worker と minecraft skill を許可する", () => {
		const config = createTestConfig({
			minecraft: {
				host: "localhost",
				port: 25565,
				username: "hua",
				authMode: "offline",
				mcpPort: 3001,
				viewerPort: 3007,
			},
			shellAgent: {
				enabled: true,
				agent: {
					providerId: "shell-provider",
					modelId: "shell-model",
				},
				dataDir: "/tmp/shell-workspaces",
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
				opencodeAgents?: Record<string, { tools?: Record<string, boolean>; permission?: unknown }>;
			};
		};

		const build = agent.profile.opencodeAgents?.build as
			| { tools?: Record<string, boolean>; permission?: { skill?: Record<string, string> } }
			| undefined;
		const worker = agent.profile.opencodeAgents?.["shell-worker"] as
			| { tools?: Record<string, boolean>; permission?: { skill?: Record<string, string> } }
			| undefined;

		expect(agent.profile.primaryTools).toEqual(["task", "skill"]);
		expect(build?.tools?.skill).toBe(true);
		expect(build?.permission?.skill).toEqual({
			"*": "deny",
			"delegate-to-shell-worker": "allow",
			"self-update": "allow",
			minecraft: "allow",
		});
		expect(worker?.permission?.skill).toEqual({
			"*": "deny",
			debug: "allow",
			"skill-creator": "allow",
		});
		expect(worker?.permission).toMatchObject({
			"*_*": "deny",
			"discord_*": "deny",
			"minecraft_*": "deny",
		});
	});
});

function emailCheckDueReminder(): DueReminder {
	return {
		reminder: {
			id: "email-check",
			description: "メール確認",
			schedule: { type: "interval", minutes: 5 },
			lastExecutedAt: null,
			enabled: true,
		},
		overdueMinutes: 0,
	};
}

function otherDueReminder(id: string): DueReminder {
	return {
		reminder: {
			id,
			description: id,
			schedule: { type: "interval", minutes: 60 },
			lastExecutedAt: null,
			enabled: true,
		},
		overdueMinutes: 0,
	};
}

function newMailFetchPayload() {
	return {
		hasNewMail: true,
		count: 1,
		emails: [
			{ subject: "件名", from: "a@example.com", date: "2026-06-10T09:00:00Z", bodyExcerpt: "本文" },
		],
	};
}

describe("buildEmailCheckPreFilter 内部分岐", () => {
	const EMAIL_CONFIG = { endpoint: "https://example.com/exec", token: "tok" };
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	const emailCheckDue = emailCheckDueReminder;
	const otherDue = otherDueReminder;
	const newMailPayload = newMailFetchPayload;

	function mockFetchJson(payload: unknown): void {
		globalThis.fetch = mock(() =>
			Promise.resolve({
				ok: true,
				status: 200,
				json: () => Promise.resolve(payload),
				text: () => Promise.resolve(""),
			} as Response),
		) as unknown as typeof globalThis.fetch;
	}

	test("dueReminders が空なら fetch せず空 reminders を返す", async () => {
		const fetchSpy = mock(() => Promise.reject(new Error("should not fetch")));
		globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
		const preFilter = buildEmailCheckPreFilter(createMockLogger(), EMAIL_CONFIG);
		if (!preFilter) throw new Error("preFilter should be defined");

		const result = await preFilter([]);

		expect(result.reminders).toEqual([]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test("新着あり: 元の DueReminder オブジェクトを破壊せず複製に context を注入する", async () => {
		mockFetchJson(newMailPayload());
		const preFilter = buildEmailCheckPreFilter(createMockLogger(), EMAIL_CONFIG);
		if (!preFilter) throw new Error("preFilter should be defined");

		const original = emailCheckDue();
		const result = await preFilter([original]);

		expect(original.context).toBeUndefined();
		const enriched = result.reminders.find((r) => r.reminder.id === "email-check");
		expect(enriched).not.toBe(original);
		expect(enriched?.context).toBeDefined();
	});

	test("新着あり: reminders は [...other, ...enriched] の順で並ぶ", async () => {
		mockFetchJson(newMailPayload());
		const preFilter = buildEmailCheckPreFilter(createMockLogger(), EMAIL_CONFIG);
		if (!preFilter) throw new Error("preFilter should be defined");

		const result = await preFilter([emailCheckDue(), otherDue("home-check")]);

		expect(result.reminders.map((r) => r.reminder.id)).toEqual(["home-check", "email-check"]);
	});

	test("新着あり: 複数の email-check reminder すべてに同一 context を注入する", async () => {
		mockFetchJson(newMailPayload());
		const preFilter = buildEmailCheckPreFilter(createMockLogger(), EMAIL_CONFIG);
		if (!preFilter) throw new Error("preFilter should be defined");

		const result = await preFilter([emailCheckDue(), emailCheckDue()]);

		const enriched = result.reminders.filter((r) => r.reminder.id === "email-check");
		expect(enriched).toHaveLength(2);
		expect(enriched[0]?.context).toBe(enriched[1]?.context);
		expect(enriched[0]?.context).toContain("<email_context>");
	});

	test("新着あり: 注入される context は本文抜粋を含む", async () => {
		mockFetchJson(newMailPayload());
		const preFilter = buildEmailCheckPreFilter(createMockLogger(), EMAIL_CONFIG);
		if (!preFilter) throw new Error("preFilter should be defined");

		const result = await preFilter([emailCheckDue()]);

		const enriched = result.reminders.find((r) => r.reminder.id === "email-check");
		expect(enriched?.context).toContain("件名");
		expect(enriched?.context).toContain("本文");
	});

	test("新着なし: 新着 0 件のときは markExecutedIds=['email-check'] で除外する", async () => {
		mockFetchJson({ hasNewMail: false, count: 0, emails: [] });
		const preFilter = buildEmailCheckPreFilter(createMockLogger(), EMAIL_CONFIG);
		if (!preFilter) throw new Error("preFilter should be defined");

		const result = await preFilter([emailCheckDue(), otherDue("home-check")]);

		expect(result.reminders.map((r) => r.reminder.id)).toEqual(["home-check"]);
		expect(result.markExecutedIds).toEqual(["email-check"]);
	});

	test("fetch 失敗時は logger.error を呼びつつ markExecutedIds で除外する", async () => {
		globalThis.fetch = mock(() =>
			Promise.reject(new Error("network down")),
		) as unknown as typeof globalThis.fetch;
		const logger = createMockLogger();
		const preFilter = buildEmailCheckPreFilter(logger, EMAIL_CONFIG);
		if (!preFilter) throw new Error("preFilter should be defined");

		const result = await preFilter([emailCheckDue()]);

		expect(logger.error).toHaveBeenCalled();
		expect(result.reminders).toEqual([]);
		expect(result.markExecutedIds).toEqual(["email-check"]);
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
		expect(agent.sessionPort.config.skillPaths).toBeUndefined();
	});
});
