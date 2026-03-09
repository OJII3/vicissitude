import { resolve } from "path";

import type { McpServerConfig } from "./profile.ts";

export const BASE_PORT = 4096;

/**
 * MCP サーバー設定を返す。
 * core-server.ts が discord / memory / schedule / event-buffer / ltm を統合。
 */
export function mcpServerConfigs(options?: { guildId?: string }) {
	const root = resolve(import.meta.dirname, "../..");

	const configs: Record<string, McpServerConfig> = {
		core: {
			type: "local",
			command: ["bun", "run", resolve(root, "src/mcp/core-server.ts")],
			environment: {
				DISCORD_TOKEN: process.env.DISCORD_TOKEN ?? "",
				LTM_OPENCODE_PORT: String(BASE_PORT - 1),
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

	if (process.env.MC_HOST) {
		const mcMcpPort = process.env.MC_MCP_PORT ?? "3001";
		configs.minecraft = {
			type: "remote",
			url: `http://localhost:${mcMcpPort}/mcp`,
		};
	}

	return configs;
}
