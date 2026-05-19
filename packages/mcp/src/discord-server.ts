import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	discordGuildIdFromScopeId,
	type MemoryNamespace,
	resolveNamespaceFromAgentId,
} from "@vicissitude/memory/namespace";
import { ConsoleLogger } from "@vicissitude/observability/logger";
import { closeDb, createDb } from "@vicissitude/store/db";
import { SqliteMoodStore } from "@vicissitude/store/mood-store";
import { Client } from "discord.js";

import { createEmotionAnalyzer, readEmotionEstimationConfigFromEnv } from "./emotion.ts";
import { registerDiscordTools } from "./tools/discord.ts";
import { registerDiscordBridgeTools } from "./tools/mc-bridge-discord.ts";

/**
 * Discord MCP サーバーのエントリポイント（stdio モード）。
 *
 * Discord REST 操作と Discord 側から使う Minecraft bridge を core MCP から分離する。
 * login() は呼ばず、Gateway セッションは作らない。
 */
async function main(): Promise<void> {
	const logger = new ConsoleLogger({ destination: "stderr" });

	const AGENT_ID = process.env.AGENT_ID;
	if (!AGENT_ID) {
		logger.error("[discord-server] AGENT_ID environment variable is required");
		process.exit(1);
	}

	const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
	if (!DISCORD_TOKEN) {
		logger.error("[discord-server] DISCORD_TOKEN environment variable is required");
		process.exit(1);
	}

	const DATA_DIR = process.env.DATA_DIR ?? "data";

	const discordClient = new Client({ intents: [] });
	discordClient.token = DISCORD_TOKEN;
	discordClient.rest.setToken(DISCORD_TOKEN);

	const db = createDb(DATA_DIR);
	const moodStore = new SqliteMoodStore(db);
	const emotionAnalyzer = createEmotionAnalyzer(
		readEmotionEstimationConfigFromEnv(process.env),
		logger,
	);

	const boundNamespace: MemoryNamespace | undefined =
		resolveNamespaceFromAgentId(AGENT_ID) ?? undefined;
	if (!boundNamespace) {
		logger.warn(
			`[discord-server] AGENT_ID=${AGENT_ID} did not resolve to a known namespace — tools require explicit guild_id`,
		);
	}
	const boundScopeId =
		boundNamespace?.surface === "agent-scope" ? boundNamespace.scopeId : undefined;
	const boundGuildId = boundScopeId
		? (discordGuildIdFromScopeId(boundScopeId) ?? undefined)
		: undefined;
	const moodKey = boundGuildId ? `discord:${boundGuildId}` : AGENT_ID;

	const server = new McpServer({ name: "discord", version: "1.0.0" });

	registerDiscordTools(
		server,
		{
			discordClient,
			emotionAnalyzer: emotionAnalyzer?.analyzer,
			moodWriter: moodStore,
			agentId: AGENT_ID,
			moodKey,
			logger,
		},
		boundGuildId,
	);

	if (process.env.MC_HOST) {
		registerDiscordBridgeTools(server, { db }, boundGuildId);
	}

	async function shutdown() {
		await server.close();
		void discordClient.destroy();
		emotionAnalyzer?.close();
		closeDb(db);
		process.exit(0);
	}

	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());

	const transport = new StdioServerTransport();
	await server.connect(transport);
}

if (import.meta.main) {
	void main();
}
