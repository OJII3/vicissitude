import {
	discordDmUserIdFromScopeId,
	discordGuildIdFromScopeId,
} from "@vicissitude/memory/namespace";
import { closeDb, createDb } from "@vicissitude/store/db";
import { SqliteMoodStore } from "@vicissitude/store/mood-store";
import { Client } from "discord.js";

import { createEmotionAnalyzerWithStoreDb, readEmotionEstimationConfigFromEnv } from "./emotion.ts";
import { runStdioMcpServer, type StdioMcpServerContext } from "./run-stdio-mcp-server.ts";
import { registerDiscordTools } from "./tools/discord.ts";
import { registerDiscordBridgeTools } from "./tools/mc-bridge-discord.ts";

/**
 * Discord MCP サーバーのエントリポイント（stdio モード）。
 *
 * Discord REST 操作と Discord 側から使う Minecraft bridge を core MCP から分離する。
 * login() は呼ばず、Gateway セッションは作らない。
 */
function setup(ctx: StdioMcpServerContext): () => void {
	const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
	if (!DISCORD_TOKEN) {
		ctx.logger.error("[discord-server] DISCORD_TOKEN environment variable is required");
		process.exit(1);
	}

	const DATA_DIR = process.env.DATA_DIR ?? "data";

	const discordClient = new Client({ intents: [] });
	discordClient.token = DISCORD_TOKEN;
	discordClient.rest.setToken(DISCORD_TOKEN);

	const db = createDb(DATA_DIR);
	const moodStore = new SqliteMoodStore(db);
	const emotionAnalyzer = createEmotionAnalyzerWithStoreDb(
		readEmotionEstimationConfigFromEnv(process.env),
		ctx.logger,
		db,
	);

	const boundScopeId = ctx.boundScopeId;
	const boundGuildId = boundScopeId
		? (discordGuildIdFromScopeId(boundScopeId) ?? undefined)
		: undefined;
	const boundDmUserId = boundScopeId
		? (discordDmUserIdFromScopeId(boundScopeId) ?? undefined)
		: undefined;
	const moodKey = boundGuildId ? `discord:${boundGuildId}` : ctx.agentId;

	registerDiscordTools(
		ctx.server,
		{
			discordClient,
			emotionAnalyzer: emotionAnalyzer?.analyzer,
			moodWriter: moodStore,
			agentId: ctx.agentId,
			moodKey,
			logger: ctx.logger,
		},
		{ guildId: boundGuildId, dmUserId: boundDmUserId },
	);

	if (process.env.MC_HOST) {
		registerDiscordBridgeTools(ctx.server, { db }, boundGuildId);
	}

	// helper が server.close() 後に呼ぶ cleanup
	return () => {
		void discordClient.destroy();
		emotionAnalyzer?.close();
		closeDb(db);
	};
}

if (import.meta.main) {
	void runStdioMcpServer({
		name: "discord",
		version: "1.0.0",
		missingScopeHint: "guild_id",
		setup,
	});
}
