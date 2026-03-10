import { resolve } from "path";

import type { McpServerConfig } from "./profile.ts";

const DEFAULT_BASE_PORT = 4096;

/**
 * MCP サーバー設定を返す。
 * core MCP は HTTP サーバーとして全 guild で共有。
 */
export function mcpServerConfigs() {
	const root = resolve(import.meta.dirname, "../..");
	const basePort = Number(process.env.OPENCODE_BASE_PORT ?? String(DEFAULT_BASE_PORT));
	const coreMcpPort = Number(process.env.CORE_MCP_PORT ?? String(basePort - 1));

	const configs: Record<string, McpServerConfig> = {
		core: {
			type: "remote",
			url: `http://localhost:${coreMcpPort}/mcp`,
		},
		"code-exec": {
			type: "local",
			command: ["bun", "run", resolve(root, "src/mcp/code-exec-server.ts")],
		},
	};

	return configs;
}

/**
 * Minecraft サブブレイン用 MCP サーバー設定を返す。
 * mc-sub-server.ts（ブリッジ）+ minecraft MCP（MC_HOST 設定時のみ）。
 */
export function mcpMinecraftSubBrainConfigs(): Record<string, McpServerConfig> {
	const root = resolve(import.meta.dirname, "../..");

	const configs: Record<string, McpServerConfig> = {
		"mc-bridge": {
			type: "local",
			command: ["bun", "run", resolve(root, "src/mcp/minecraft/mc-sub-server.ts")],
			environment: {
				DATA_DIR: resolve(root, "data"),
			},
		},
	};

	if (process.env.MC_HOST) {
		const mcMcpPort = process.env.MC_MCP_PORT ?? "3001";
		configs.minecraft = {
			type: "remote",
			url: `http://localhost:${mcMcpPort}/mcp`,
		};
	}

	return configs;
}
