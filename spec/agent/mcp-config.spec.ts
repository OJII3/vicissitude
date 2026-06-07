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
