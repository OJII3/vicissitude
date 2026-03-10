import { resolve } from "path";

import type { McpServerConfig } from "./profile.ts";

const DEFAULT_BASE_PORT = 4096;

/**
 * MCP サーバー設定を返す。
 * core-server.ts が discord / memory / schedule / event-buffer / ltm を統合。
 */
export function mcpServerConfigs(options?: { guildId?: string }) {
	const root = resolve(import.meta.dirname, "../..");
	const basePort = Number(process.env.OPENCODE_BASE_PORT ?? String(DEFAULT_BASE_PORT));

	const configs: Record<string, McpServerConfig> = {
		core: {
			type: "local",
			command: ["bun", "run", resolve(root, "src/mcp/core-server.ts")],
			environment: {
				DISCORD_TOKEN: process.env.DISCORD_TOKEN ?? "",
				LTM_OPENCODE_PORT: String(basePort - 1),
				LTM_PROVIDER_ID:
					process.env.LTM_PROVIDER_ID ?? process.env.OPENCODE_PROVIDER_ID ?? "github-copilot",
				LTM_MODEL_ID: process.env.LTM_MODEL_ID ?? "gpt-4o",
				OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL ?? "http://ollama:11434",
				LTM_EMBEDDING_MODEL: process.env.LTM_EMBEDDING_MODEL ?? "embeddinggemma",
				LTM_DATA_DIR: resolve(root, "data/fenghuang"),
				DATA_DIR: resolve(root, "data"),
				GUILD_ID: options?.guildId ?? "",
			},
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
			command: ["bun", "run", resolve(root, "src/mcp/mc-sub-server.ts")],
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
