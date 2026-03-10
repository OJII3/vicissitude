import { mkdirSync } from "fs";
import { resolve } from "path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client, GatewayIntentBits } from "discord.js";
import { type Fenghuang, SQLiteStorageAdapter, createFenghuang } from "fenghuang";

import { OPENCODE_ALL_TOOLS_DISABLED } from "../core/constants.ts";
import { CompositeLLMAdapter } from "../fenghuang/composite-llm-adapter.ts";
import { FenghuangChatAdapter } from "../fenghuang/fenghuang-chat-adapter.ts";
import { OllamaEmbeddingAdapter } from "../ollama/ollama-embedding-adapter.ts";
import { OpencodeSessionAdapter } from "../opencode/session-adapter.ts";
import { closeDb, createDb } from "../store/db.ts";
import { startHttpServer } from "./http-server.ts";
import { registerDiscordTools } from "./tools/discord.ts";
import { registerEventBufferTools } from "./tools/event-buffer.ts";
import { registerLtmTools } from "./tools/ltm.ts";
import { registerMainBrainBridgeTools } from "./tools/mc-bridge-main.ts";
import { registerMemoryTools } from "./tools/memory.ts";
import { registerScheduleTools } from "./tools/schedule.ts";

// --- Configuration from environment ---

const CORE_MCP_PORT = Number(process.env.CORE_MCP_PORT ?? "4095");
const LTM_OPENCODE_PORT = Number(process.env.LTM_OPENCODE_PORT ?? "4094");
const LTM_PROVIDER_ID = process.env.LTM_PROVIDER_ID ?? "github-copilot";
const LTM_MODEL_ID = process.env.LTM_MODEL_ID ?? "gpt-4o";
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://ollama:11434";
const LTM_EMBEDDING_MODEL = process.env.LTM_EMBEDDING_MODEL ?? "embeddinggemma";
const LTM_DATA_DIR = process.env.LTM_DATA_DIR ?? "data/fenghuang";
const DATA_DIR = process.env.DATA_DIR ?? "data";

if (!process.env.DISCORD_TOKEN) {
	console.error("[core-server] DISCORD_TOKEN environment variable is required");
	process.exit(1);
}

// --- Discord Client ---

const discordClient = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
	],
});

try {
	await discordClient.login(process.env.DISCORD_TOKEN);
} catch (err) {
	console.error("[core-server] Failed to login to Discord:", err);
	process.exit(1);
}

// --- Drizzle DB ---

const db = createDb(DATA_DIR);

// --- Fenghuang (LTM) ---

const ltmSessionPort = new OpencodeSessionAdapter({
	port: LTM_OPENCODE_PORT,
	mcpServers: {},
	builtinTools: OPENCODE_ALL_TOOLS_DISABLED,
});
const chatAdapter = new FenghuangChatAdapter(ltmSessionPort, LTM_PROVIDER_ID, LTM_MODEL_ID);

const ollama = new OllamaEmbeddingAdapter(OLLAMA_BASE_URL, LTM_EMBEDDING_MODEL);
const llm = new CompositeLLMAdapter(chatAdapter, ollama);

const MAX_FENGHUANG_INSTANCES = 50;
const fenghuangInstances = new Map<string, Fenghuang>();
const fenghuangStorages = new Map<string, SQLiteStorageAdapter>();

const GUILD_ID_REGEX = /^\d+$/;

function getOrCreateFenghuang(guildId: string): Fenghuang {
	if (!GUILD_ID_REGEX.test(guildId)) {
		throw new Error(`Invalid guildId: ${guildId}`);
	}

	const existing = fenghuangInstances.get(guildId);
	if (existing) {
		// LRU: 再挿入して最新アクセスとして記録
		fenghuangInstances.delete(guildId);
		fenghuangInstances.set(guildId, existing);
		return existing;
	}

	// Evict oldest entry if at capacity
	if (fenghuangInstances.size >= MAX_FENGHUANG_INSTANCES) {
		const oldestKey = fenghuangInstances.keys().next().value as string;
		fenghuangInstances.delete(oldestKey);
		const oldStorage = fenghuangStorages.get(oldestKey);
		oldStorage?.close();
		fenghuangStorages.delete(oldestKey);
	}

	const dbDir = resolve(LTM_DATA_DIR, "guilds", guildId);
	mkdirSync(dbDir, { recursive: true });
	const storage = new SQLiteStorageAdapter(resolve(dbDir, "memory.db"));
	const instance = createFenghuang({ llm, storage });
	fenghuangInstances.set(guildId, instance);
	fenghuangStorages.set(guildId, storage);
	return instance;
}

// --- MCP Server Factory ---

function createServer(): McpServer {
	const server = new McpServer({ name: "core", version: "1.0.0" });

	registerDiscordTools(server, { discordClient });
	registerMemoryTools(server);
	registerScheduleTools(server);
	registerEventBufferTools(server, { db });
	registerLtmTools(server, { getOrCreateFenghuang });
	registerMainBrainBridgeTools(server, { db });

	return server;
}

// --- Start HTTP Server ---

const { cleanupTimer, closeAllSessions } = startHttpServer(createServer, CORE_MCP_PORT, "core");

// --- Graceful Shutdown ---

async function shutdown() {
	clearInterval(cleanupTimer);
	closeAllSessions();
	discordClient.destroy();
	for (const storage of fenghuangStorages.values()) {
		storage.close();
	}
	fenghuangInstances.clear();
	fenghuangStorages.clear();
	await chatAdapter.close();
	closeDb(db);
	process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
