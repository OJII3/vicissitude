import { describe, expect, it } from "bun:test";

import { mcpMinecraftConfigs, mcpServerConfigs } from "@vicissitude/agent/mcp-config";

// ─── mcpServerConfigs ────────────────────────────────────────────

describe("mcpServerConfigs", () => {
	const defaultOpts = { appRoot: "/test/root", coreMcpPort: 4095 };

	it("core と code-exec のみ返す", () => {
		const configs = mcpServerConfigs("discord:123", defaultOpts);
		expect(Object.keys(configs).toSorted()).toEqual(["code-exec", "core"]);
	});

	it("core は remote 型", () => {
		const configs = mcpServerConfigs("discord:123", defaultOpts);
		expect(configs.core?.type).toBe("remote");
	});

	it("core の URL に agent_id クエリパラメータが含まれる", () => {
		const configs = mcpServerConfigs("discord:123", defaultOpts);
		const core = configs.core;
		expect(core?.type).toBe("remote");
		if (core?.type === "remote") {
			const url = new URL(core.url);
			expect(url.searchParams.get("agent_id")).toBe("discord:123");
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
