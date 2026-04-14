import { resolve } from "path";

import type { McpServerConfig } from "./profile.ts";

const DEFAULT_BASE_PORT = 4096;

function getRoot(): string {
	const fallback: string = resolve(import.meta.dirname, "../..");
	const root: string = process.env.APP_ROOT ?? fallback;
	return root;
}

/**
 * MCP サーバー設定を返す。
 * core MCP は HTTP サーバーとして全 guild で共有。
 * agentId は URL クエリパラメータとしてサーバーに渡され、wait_for_events のバインドに使われる。
 */
export function mcpServerConfigs(agentId: string) {
	const root = getRoot();
	const basePort = Number(process.env.OPENCODE_BASE_PORT ?? String(DEFAULT_BASE_PORT));
	const coreMcpPort = Number(process.env.CORE_MCP_PORT ?? String(basePort - 1));

	const configs: Record<string, McpServerConfig> = {
		core: {
			type: "remote",
			url: `http://localhost:${coreMcpPort}/mcp?agent_id=${encodeURIComponent(agentId)}`,
		},
		"code-exec": {
			type: "local",
			command: ["bun", "run", resolve(root, "dist/code-exec-server.js")],
		},
	};

	return configs;
}

/**
 * Minecraft エージェント用 MCP サーバー設定を返す。
 * mc-bridge-server.ts（ブリッジ）+ minecraft MCP（MC_HOST 設定時のみ）。
 */
export function mcpMinecraftConfigs(): Record<string, McpServerConfig> {
	const root = getRoot();

	const configs: Record<string, McpServerConfig> = {
		"mc-bridge": {
			type: "local",
			command: ["bun", "run", resolve(root, "dist/mc-bridge-server.js")],
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
