import { resolve } from "path";

import type { McpServerConfig } from "./profile.ts";

export interface McpConfigOptions {
	appRoot: string;
	coreMcpPort: number;
}

/**
 * MCP サーバー設定を返す。
 * core MCP は HTTP サーバーとして全 guild で共有。
 * agentId は URL クエリパラメータとしてサーバーに渡され、wait_for_events のバインドに使われる。
 */
export function mcpServerConfigs(agentId: string, opts: McpConfigOptions) {
	const { appRoot, coreMcpPort } = opts;

	const configs: Record<string, McpServerConfig> = {
		core: {
			type: "remote",
			url: `http://localhost:${coreMcpPort}/mcp?agent_id=${encodeURIComponent(agentId)}`,
		},
		"code-exec": {
			type: "local",
			command: ["bun", "run", resolve(appRoot, "dist/code-exec-server.js")],
		},
	};

	return configs;
}

export interface McpMinecraftConfigOptions {
	appRoot: string;
	mcHost?: string;
	mcMcpPort?: string;
}

/**
 * Minecraft エージェント用 MCP サーバー設定を返す。
 * mc-bridge-server.ts（ブリッジ）+ minecraft MCP（MC_HOST 設定時のみ）。
 */
export function mcpMinecraftConfigs(
	opts: McpMinecraftConfigOptions,
): Record<string, McpServerConfig> {
	const { appRoot, mcHost, mcMcpPort } = opts;

	const configs: Record<string, McpServerConfig> = {
		"mc-bridge": {
			type: "local",
			command: ["bun", "run", resolve(appRoot, "dist/mc-bridge-server.js")],
			environment: {
				DATA_DIR: resolve(appRoot, "data"),
			},
		},
	};

	if (mcHost) {
		configs.minecraft = {
			type: "remote",
			url: `http://localhost:${mcMcpPort ?? "3001"}/mcp`,
		};
	}

	return configs;
}
