import { afterEach, describe, expect, it } from "bun:test";

import { mcpMinecraftConfigs, mcpServerConfigs } from "@vicissitude/agent/mcp-config";

// ─── mcpServerConfigs ────────────────────────────────────────────

describe("mcpServerConfigs", () => {
	const originalEnv = { ...process.env };

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it("core と code-exec のみ返す", () => {
		const configs = mcpServerConfigs("discord:123");
		expect(Object.keys(configs).toSorted()).toEqual(["code-exec", "core"]);
	});

	it("core は remote 型", () => {
		const configs = mcpServerConfigs("discord:123");
		expect(configs.core?.type).toBe("remote");
	});

	it("core の URL に agent_id クエリパラメータが含まれる", () => {
		const configs = mcpServerConfigs("discord:123");
		const core = configs.core;
		expect(core?.type).toBe("remote");
		if (core?.type === "remote") {
			const url = new URL(core.url);
			expect(url.searchParams.get("agent_id")).toBe("discord:123");
		}
	});

	it("MC_HOST が設定されていても minecraft を含まない", () => {
		process.env.MC_HOST = "localhost";
		process.env.MC_MCP_PORT = "3001";
		const configs = mcpServerConfigs("discord:456");
		expect(configs).not.toHaveProperty("minecraft");
	});
});

// ─── mcpMinecraftConfigs ─────────────────────────────────────

describe("mcpMinecraftConfigs", () => {
	const originalEnv = { ...process.env };

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it("MC_HOST 未設定時は mc-bridge のみ返す", () => {
		delete process.env.MC_HOST;
		const configs = mcpMinecraftConfigs();
		expect(Object.keys(configs)).toEqual(["mc-bridge"]);
	});

	it("MC_HOST 設定時は mc-bridge と minecraft を返す", () => {
		process.env.MC_HOST = "localhost";
		const configs = mcpMinecraftConfigs();
		expect(Object.keys(configs).toSorted()).toEqual(["mc-bridge", "minecraft"]);
	});
});
