import { describe, expect, it } from "bun:test";

import { mcpMinecraftConfigs, mcpServerConfigs } from "@vicissitude/agent/mcp-config";

// ─── mcpServerConfigs ────────────────────────────────────────────

describe("mcpServerConfigs", () => {
	const defaultOpts = {
		appRoot: "/test/root",
		coreEnvironment: { DISCORD_TOKEN: "test", DATA_DIR: "/data" },
	};

	it("core と code-exec のみ返す", () => {
		const configs = mcpServerConfigs("discord:123", defaultOpts);
		expect(Object.keys(configs).toSorted()).toEqual(["code-exec", "core"]);
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
