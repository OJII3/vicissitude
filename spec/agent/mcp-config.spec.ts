import { describe, expect, it } from "bun:test";

import { mcpMinecraftConfigs, mcpServerConfigs } from "@vicissitude/agent/mcp-config";

// ─── mcpServerConfigs ────────────────────────────────────────────

describe("mcpServerConfigs", () => {
	const defaultOpts = {
		appRoot: "/test/root",
		coreEnvironment: { DISCORD_TOKEN: "test", DATA_DIR: "/data" },
	};
	const shellWorkspace = {
		image: "sandbox-image",
		dataDir: "/data/shell-workspaces",
		auditLogPath: "/data/shell-workspace-audit.jsonl",
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
			expect(core.environment?.DISCORD_TOKEN).toBe("test");
			expect(core.environment?.DATA_DIR).toBe("/data");
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
			},
		});
		const shell = configs["shell-workspace"];

		expect(shell?.type).toBe("local");
		if (shell?.type === "local") {
			expect(shell.environment?.SHELL_WORKSPACE_AGENT_ID).toBe("discord:123");
			expect(shell.environment?.SHELL_WORKSPACE_IMAGE).toBe("sandbox-image");
			expect(shell.environment?.SHELL_WORKSPACE_DATA_DIR).toBe("/data/shell-workspaces");
			expect(shell.environment?.SHELL_WORKSPACE_HOST_DATA_DIR).toBe("/host/data/shell-workspaces");
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
