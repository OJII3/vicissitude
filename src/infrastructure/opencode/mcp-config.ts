import { resolve } from "path";

export const BASE_PORT = 4096;
const GUILD_ID_REGEX = /^\d+$/;

type McpServerConfig = { type: "local"; command: string[]; environment?: Record<string, string> };

interface McpConfigOptions {
	includeEventBuffer?: boolean;
	guildId?: string;
}

function coreConfigs(root: string): Record<string, McpServerConfig> {
	return {
		discord: {
			type: "local",
			command: ["bun", "run", resolve(root, "src/mcp/discord-server.ts")],
			environment: {
				DISCORD_TOKEN: process.env.DISCORD_TOKEN ?? "",
			},
		},
		"code-exec": {
			type: "local",
			command: ["bun", "run", resolve(root, "src/mcp/code-exec-server.ts")],
		},
		schedule: {
			type: "local",
			command: ["bun", "run", resolve(root, "src/mcp/schedule-server.ts")],
		},
		memory: {
			type: "local",
			command: ["bun", "run", resolve(root, "src/mcp/memory-server.ts")],
		},
		ltm: {
			type: "local",
			command: ["bun", "run", resolve(root, "src/mcp/ltm-server.ts")],
			environment: {
				LTM_OPENCODE_PORT: String(BASE_PORT - 1),
				LTM_MODEL_ID: process.env.LTM_MODEL_ID ?? "gpt-4o",
				OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
				LTM_EMBEDDING_MODEL: process.env.LTM_EMBEDDING_MODEL ?? "embeddinggemma",
				LTM_DATA_DIR: resolve(root, "data/fenghuang"),
			},
		},
	};
}

/**
 * MCP サーバー設定を返す。
 * PollingAgent のみ includeEventBuffer: true で呼ぶ。
 */
export function mcpServerConfigs(options?: McpConfigOptions) {
	const root = resolve(import.meta.dirname, "../../..");
	const configs = coreConfigs(root);

	if (options?.includeEventBuffer) {
		const environment: Record<string, string> = {};
		if (options.guildId) {
			if (!GUILD_ID_REGEX.test(options.guildId)) {
				throw new Error(`Invalid guildId: ${options.guildId}`);
			}
			environment.EVENT_BUFFER_DIR = resolve(root, `data/event-buffer/guilds/${options.guildId}`);
		}
		configs["event-buffer"] = {
			type: "local",
			command: ["bun", "run", resolve(root, "src/mcp/event-buffer-server.ts")],
			environment,
		};
	}

	return configs;
}
