import { resolve } from "path";

import type { McpServerConfig } from "./profile.ts";

export interface McpConfigOptions {
	appRoot: string;
	/** core MCP プロセスに渡す環境変数 */
	coreEnvironment: Record<string, string>;
	/** Discord MCP プロセスに渡す環境変数。Discord agent だけが設定する。 */
	discord?: DiscordMcpConfigOptions;
}

export interface DiscordMcpConfigOptions {
	environment: Record<string, string>;
}

function localBunCommand(appRoot: string, relativePath: string): [string, string, string] {
	const entrypoint = String(resolve(appRoot, relativePath));
	return ["bun", "run", entrypoint];
}

/**
 * MCP サーバー設定を返す。
 *
 * core MCP は stdio (local) モードでエージェントごとに子プロセスとして起動される。
 * AGENT_ID 環境変数でエージェントの識別に使用される。
 */
export function mcpServerConfigs(agentId: string, opts: McpConfigOptions) {
	const { appRoot, coreEnvironment } = opts;

	const configs: Record<string, McpServerConfig> = {
		core: {
			type: "local",
			command: localBunCommand(appRoot, "packages/mcp/src/core-server.ts"),
			environment: {
				...coreEnvironment,
				AGENT_ID: agentId,
			},
		},
	};

	if (opts.discord) {
		configs.discord = {
			type: "local",
			command: localBunCommand(appRoot, "packages/mcp/src/discord-server.ts"),
			environment: {
				...opts.discord.environment,
				AGENT_ID: agentId,
			},
		};
	}

	return configs;
}

export interface McpMinecraftConfigOptions {
	appRoot: string;
	mcHost?: string;
	mcMcpPort?: string;
}

/**
 * Minecraft エージェント用 MCP サーバー設定を返す。
 * mc-bridge-server.ts（ブリッジ）+ minecraft MCP（profile の minecraft 設定時のみ）。
 */
export function mcpMinecraftConfigs(
	opts: McpMinecraftConfigOptions,
): Record<string, McpServerConfig> {
	const { appRoot, mcHost, mcMcpPort } = opts;

	const configs: Record<string, McpServerConfig> = {
		"mc-bridge": {
			type: "local",
			command: localBunCommand(appRoot, "packages/minecraft/src/mc-bridge-server.ts"),
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
