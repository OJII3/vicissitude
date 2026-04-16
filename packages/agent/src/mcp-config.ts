import { resolve } from "path";

import type { McpServerConfig } from "./profile.ts";

export interface McpConfigOptions {
	appRoot: string;
	/** core MCP プロセスに渡す環境変数 */
	coreEnvironment: Record<string, string>;
}

/**
 * MCP サーバー設定を返す。
 *
 * core MCP は stdio (local) モードでエージェントごとに子プロセスとして起動される。
 * AGENT_ID 環境変数で wait_for_events のバインド先を指定する。
 *
 * @see {@link ../../mcp/src/tools/event-buffer.ts} — ポーリングモデルの詳細
 */
export function mcpServerConfigs(agentId: string, opts: McpConfigOptions) {
	const { appRoot, coreEnvironment } = opts;

	const configs: Record<string, McpServerConfig> = {
		core: {
			type: "local",
			command: ["bun", "run", resolve(appRoot, "dist/core-server.js")],
			environment: {
				...coreEnvironment,
				AGENT_ID: agentId,
			},
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
