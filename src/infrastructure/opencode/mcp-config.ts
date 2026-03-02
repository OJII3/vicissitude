import { resolve } from "path";

const GUILD_ID_REGEX = /^\d+$/;

interface McpConfigOptions {
	includeEventBuffer?: boolean;
	guildId?: string;
}

/**
 * MCP サーバー設定を返す。OpenCode / Copilot 両方から使う共通設定。
 * CopilotPollingAgent のみ includeEventBuffer: true で呼ぶ。
 */
export function mcpServerConfigs(options?: McpConfigOptions) {
	const root = resolve(import.meta.dirname, "../../..");

	const configs: Record<
		string,
		{ type: "local"; command: string[]; environment?: Record<string, string> }
	> = {
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
	};

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
