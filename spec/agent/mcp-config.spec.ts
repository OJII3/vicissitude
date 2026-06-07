import { describe, expect, it } from "bun:test";

import { mcpMinecraftConfigs, mcpServerConfigs } from "@vicissitude/agent/mcp-config";

// ─── mcpServerConfigs ────────────────────────────────────────────

describe("mcpServerConfigs", () => {
	const defaultOpts = {
		appRoot: "/test/root",
		coreEnvironment: { DATA_DIR: "/data" },
	};
	const discord = {
		environment: { DISCORD_TOKEN: "test", DATA_DIR: "/data" },
	};
	const shellWorkspace = {
		image: "sandbox-image",
		dataDir: "/data/shell-workspaces",
		auditLogPath: "/data/shell-workspace-audit.jsonl",
		networkProfile: "open" as const,
		defaultTtlMinutes: 60,
		maxTtlMinutes: 120,
		defaultTimeoutSeconds: 30,
		maxTimeoutSeconds: 120,
		maxOutputChars: 50_000,
	};

	it("デフォルトでは core のみ返す", () => {
		const configs = mcpServerConfigs("discord:123", defaultOpts);
		expect(Object.keys(configs).toSorted()).toEqual(["core"]);
	});

	it("core は local 型", () => {
		const configs = mcpServerConfigs("discord:123", defaultOpts);
		expect(configs.core?.type).toBe("local");
	});

	it("core の environment に AGENT_ID が設定される", () => {
		const configs = mcpServerConfigs("discord:123", defaultOpts);
		const core = configs.core;
		expect(core?.type).toBe("local");
		if (core?.type === "local") {
			expect(core.environment?.AGENT_ID).toBe("discord:123");
		}
	});

	it("core の environment に coreEnvironment の値が含まれる", () => {
		const configs = mcpServerConfigs("discord:123", defaultOpts);
		const core = configs.core;
		if (core?.type === "local") {
			expect(core.environment?.DATA_DIR).toBe("/data");
		}
	});

	it("discord option が有効な場合だけ discord MCP を返す", () => {
		const configs = mcpServerConfigs("discord:123", {
			...defaultOpts,
			discord,
		});

		expect(Object.keys(configs).toSorted()).toEqual(["core", "discord"]);
	});

	it("discord MCP は discord-server entrypoint と AGENT_ID 付き environment を使う", () => {
		const configs = mcpServerConfigs("discord:123", {
			...defaultOpts,
			discord,
		});
		const discordConfig = configs.discord;

		expect(discordConfig?.type).toBe("local");
		if (discordConfig?.type === "local") {
			expect(discordConfig.command).toEqual([
				"bun",
				"run",
				"/test/root/packages/mcp/src/discord-server.ts",
			]);
			expect(discordConfig.environment?.AGENT_ID).toBe("discord:123");
			expect(discordConfig.environment?.DISCORD_TOKEN).toBe("test");
		}
	});

	it("discord MCP の environment は coreEnvironment を混ぜない", () => {
		const configs = mcpServerConfigs("discord:123", {
			...defaultOpts,
			discord,
		});
		const discordConfig = configs.discord;

		if (discordConfig?.type === "local") {
			expect(discordConfig.environment?.DATA_DIR).toBe("/data");
			expect(discordConfig.environment?.MEMORY_DATA_DIR).toBeUndefined();
		}
	});

	it("shell-workspace capability が有効な場合だけ shell-workspace を返す", () => {
		const configs = mcpServerConfigs("discord:123", {
			...defaultOpts,
			capabilities: ["shell-workspace"],
			shellWorkspace,
		});

		expect(Object.keys(configs).toSorted()).toEqual(["core", "shell-workspace"]);
	});

	it("shell-workspace の environment は専用設定のみを含む", () => {
		const configs = mcpServerConfigs("discord:123", {
			...defaultOpts,
			capabilities: ["shell-workspace"],
			shellWorkspace: {
				...shellWorkspace,
				hostDataDir: "/host/data/shell-workspaces",
				environment: {
					GH_TOKEN: "github-token",
					GITHUB_TOKEN: "github-token",
				},
				git: {
					userName: "ふあ",
					userEmail: "282728168+agenthua@users.noreply.github.com",
				},
			},
		});
		const shell = configs["shell-workspace"];

		expect(shell?.type).toBe("local");
		if (shell?.type === "local") {
			expect(shell.environment?.SHELL_WORKSPACE_AGENT_ID).toBe("discord:123");
			expect(shell.environment?.SHELL_WORKSPACE_IMAGE).toBe("sandbox-image");
			expect(shell.environment?.SHELL_WORKSPACE_DATA_DIR).toBe("/data/shell-workspaces");
			expect(shell.environment?.SHELL_WORKSPACE_HOST_DATA_DIR).toBe("/host/data/shell-workspaces");
			expect(shell.environment?.SHELL_WORKSPACE_NETWORK_PROFILE).toBe("open");
			expect(shell.environment?.SHELL_WORKSPACE_FORWARD_ENV).toBe("GH_TOKEN,GITHUB_TOKEN");
			expect(shell.environment?.SHELL_WORKSPACE_GIT_USER_NAME).toBe("ふあ");
			expect(shell.environment?.SHELL_WORKSPACE_GIT_USER_EMAIL).toBe(
				"282728168+agenthua@users.noreply.github.com",
			);
			expect(shell.environment?.GH_TOKEN).toBe("github-token");
			expect(shell.environment?.GITHUB_TOKEN).toBe("github-token");
			expect(shell.environment?.DISCORD_TOKEN).toBeUndefined();
		}
	});

	it("shell-workspace capability 有効時に設定がなければエラーにする", () => {
		expect(() =>
			mcpServerConfigs("discord:123", {
				...defaultOpts,
				capabilities: ["shell-workspace"],
			}),
		).toThrow("shellWorkspace config is required");
	});
});

// ─── mcpMinecraftConfigs ─────────────────────────────────────

describe("mcpMinecraftConfigs", () => {
	const defaultOpts = { appRoot: "/test/root" };

	it("mcHost 未設定時は mc-bridge のみ返す", () => {
		const configs = mcpMinecraftConfigs(defaultOpts);
		expect(Object.keys(configs)).toEqual(["mc-bridge"]);
	});

	it("mcHost 設定時は mc-bridge と minecraft を返す", () => {
		const configs = mcpMinecraftConfigs({ ...defaultOpts, mcHost: "localhost" });
		expect(Object.keys(configs).toSorted()).toEqual(["mc-bridge", "minecraft"]);
	});
});
