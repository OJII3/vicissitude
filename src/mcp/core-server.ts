import { mkdirSync } from "fs";
import { resolve } from "path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client, GatewayIntentBits } from "discord.js";
import { type Fenghuang, SQLiteStorageAdapter, createFenghuang } from "fenghuang";

import { CompositeLLMAdapter } from "../infrastructure/fenghuang/composite-llm-adapter.ts";
import { FenghuangChatAdapter } from "../infrastructure/fenghuang/fenghuang-chat-adapter.ts";
import { OllamaEmbeddingAdapter } from "../infrastructure/ollama/ollama-embedding-adapter.ts";
import { createDb } from "../store/db.ts";
import { registerDiscordTools } from "./tools/discord.ts";
import { registerEventBufferTools } from "./tools/event-buffer.ts";
import { registerLtmTools } from "./tools/ltm.ts";
import { registerMemoryTools } from "./tools/memory.ts";
import { registerScheduleTools } from "./tools/schedule.ts";

// --- Configuration from environment ---

const LTM_OPENCODE_PORT = Number(process.env.LTM_OPENCODE_PORT ?? "4095");
const LTM_PROVIDER_ID = process.env.LTM_PROVIDER_ID ?? "github-copilot";
const LTM_MODEL_ID = process.env.LTM_MODEL_ID ?? "gpt-4o";
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://ollama:11434";
const LTM_EMBEDDING_MODEL = process.env.LTM_EMBEDDING_MODEL ?? "embeddinggemma";
const LTM_DATA_DIR = process.env.LTM_DATA_DIR ?? "data/fenghuang";
const DATA_DIR = process.env.DATA_DIR ?? "data";
const GUILD_ID = process.env.GUILD_ID ?? "";

// --- Discord Client ---

const discordClient = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
	],
});

await discordClient.login(process.env.DISCORD_TOKEN);

// --- Drizzle DB ---

const db = createDb(DATA_DIR);

// --- Fenghuang (LTM) ---

const chatAdapter = new FenghuangChatAdapter(LTM_OPENCODE_PORT, LTM_PROVIDER_ID, LTM_MODEL_ID);
await chatAdapter.initialize();

const ollama = new OllamaEmbeddingAdapter(OLLAMA_BASE_URL, LTM_EMBEDDING_MODEL);
const llm = new CompositeLLMAdapter(chatAdapter, ollama);

const fenghuangInstances = new Map<string, Fenghuang>();

function getOrCreateFenghuang(guildId: string): Fenghuang {
	const existing = fenghuangInstances.get(guildId);
	if (existing) return existing;

	const dbDir = resolve(LTM_DATA_DIR, "guilds", guildId);
	mkdirSync(dbDir, { recursive: true });
	const storage = new SQLiteStorageAdapter(resolve(dbDir, "memory.db"));
	const instance = createFenghuang({ llm, storage });
	fenghuangInstances.set(guildId, instance);
	return instance;
}

// --- MCP Server ---

const server = new McpServer({ name: "core", version: "1.0.0" });

registerDiscordTools(server, { discordClient });
registerMemoryTools(server);
registerScheduleTools(server);
registerEventBufferTools(server, { db, guildId: GUILD_ID });
registerLtmTools(server, { getOrCreateFenghuang });

// --- Graceful Shutdown ---

async function shutdown() {
	await server.close();
	chatAdapter.close();
	process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// --- Start server ---

const transport = new StdioServerTransport();
await server.connect(transport);
