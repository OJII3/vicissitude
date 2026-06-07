import { describe, expect, test } from "bun:test";

import { mcpMinecraftConfigs, mcpServerConfigs } from "./mcp-config.ts";

describe("mcpServerConfigs", () => {
	test("local MCP entrypoints は source file を直接起動する", () => {
		const configs = mcpServerConfigs("discord:dm:123", {
			appRoot: "/app",
			coreEnvironment: { DATA_DIR: "/app/data" },
			discord: {
				environment: { DISCORD_TOKEN: "token", DATA_DIR: "/app/data" },
			},
		});

		expect(configs.core).toMatchObject({
			type: "local",
			command: ["bun", "run", "/app/packages/mcp/src/core-server.ts"],
		});
		expect(configs.discord).toMatchObject({
			type: "local",
			command: ["bun", "run", "/app/packages/mcp/src/discord-server.ts"],
		});
	});
});

describe("mcpMinecraftConfigs", () => {
	test("mc-bridge も source file を直接起動する", () => {
		const configs = mcpMinecraftConfigs({
			appRoot: "/app",
			mcHost: "localhost",
			mcMcpPort: "3001",
		});

		expect(configs["mc-bridge"]).toMatchObject({
			type: "local",
			command: ["bun", "run", "/app/packages/minecraft/src/mc-bridge-server.ts"],
		});
		expect(configs.minecraft).toMatchObject({
			type: "remote",
			url: "http://localhost:3001/mcp",
		});
	});
});
