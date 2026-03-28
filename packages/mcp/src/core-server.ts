import { mkdirSync } from "fs";
import { resolve } from "path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EmotionEstimator } from "@vicissitude/agent/emotion/estimator";
import { EpisodicMemory } from "@vicissitude/memory/episodic";
import type { MemoryLlmPort } from "@vicissitude/memory/llm-port";
import { Retrieval } from "@vicissitude/memory/retrieval";
import { SemanticMemory } from "@vicissitude/memory/semantic-memory";
import { MemoryStorage } from "@vicissitude/memory/storage";
import { ConsoleLogger } from "@vicissitude/observability/logger";
import { METRIC } from "@vicissitude/observability/metrics";
import { OllamaEmbeddingAdapter } from "@vicissitude/ollama";
import { OllamaChatAdapter } from "@vicissitude/ollama/ollama-chat-adapter";
import { closeDb, createDb } from "@vicissitude/store/db";
import { SqliteMoodStore } from "@vicissitude/store/mood-store";
import { Client, GatewayIntentBits } from "discord.js";

import { startHttpServer } from "./http-server.ts";
import { wrapServerWithMetrics } from "./tool-metrics.ts";
import { registerDiscordTools } from "./tools/discord.ts";
import { registerEventBufferTools } from "./tools/event-buffer.ts";
import { registerDiscordBridgeTools } from "./tools/mc-bridge-discord.ts";
import { type MemoryReadServices, registerMemoryTools } from "./tools/memory.ts";
import { registerScheduleTools } from "./tools/schedule.ts";

// --- Logger ---

const logger = new ConsoleLogger();

// --- Configuration from environment ---

const CORE_MCP_PORT = Number(process.env.CORE_MCP_PORT ?? "4095");
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://ollama:11434";
const MEMORY_EMBEDDING_MODEL = process.env.MEMORY_EMBEDDING_MODEL ?? "embeddinggemma";
const MEMORY_DATA_DIR = process.env.MEMORY_DATA_DIR ?? "data/memory";
const EMOTION_CHAT_MODEL = process.env.EMOTION_CHAT_MODEL ?? "gemma3";
const DATA_DIR = process.env.DATA_DIR ?? "data";

if (!process.env.DISCORD_TOKEN) {
	logger.error("[core-server] DISCORD_TOKEN environment variable is required");
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
	logger.error("[core-server] Failed to login to Discord:", err);
	process.exit(1);
}

// --- Drizzle DB ---

const db = createDb(DATA_DIR);
const moodStore = new SqliteMoodStore(db);

// --- Memory (embed-only — consolidation runs in the main process) ---

const ollama = new OllamaEmbeddingAdapter(OLLAMA_BASE_URL, MEMORY_EMBEDDING_MODEL);
const ollamaChat = new OllamaChatAdapter(OLLAMA_BASE_URL, EMOTION_CHAT_MODEL);
const emotionEstimator = new EmotionEstimator(ollamaChat);

/** MemoryLlmPort that only supports embed — chat/chatStructured throw since they are unused here */
const embedOnlyLlm: MemoryLlmPort = {
	chat(): Promise<never> {
		return Promise.reject(
			new Error("chat is not available in core-server (consolidation runs in main process)"),
		);
	},
	chatStructured(): Promise<never> {
		return Promise.reject(
			new Error(
				"chatStructured is not available in core-server (consolidation runs in main process)",
			),
		);
	},
	embed: (text: string) => ollama.embed(text),
};

const MAX_MEMORY_INSTANCES = 50;

const memoryInstances = new Map<string, MemoryReadServices>();
const memoryStorages = new Map<string, MemoryStorage>();

const GUILD_ID_REGEX = /^\d+$/;

function getOrCreateMemory(guildId: string): MemoryReadServices {
	if (!GUILD_ID_REGEX.test(guildId)) {
		throw new Error(`Invalid guildId: ${guildId}`);
	}

	const existing = memoryInstances.get(guildId);
	if (existing) {
		// LRU: 再挿入して最新アクセスとして記録
		memoryInstances.delete(guildId);
		memoryInstances.set(guildId, existing);
		return existing;
	}

	// Evict oldest entry if at capacity
	if (memoryInstances.size >= MAX_MEMORY_INSTANCES) {
		const oldestKey = memoryInstances.keys().next().value as string;
		memoryInstances.delete(oldestKey);
		const oldStorage = memoryStorages.get(oldestKey);
		oldStorage?.close();
		memoryStorages.delete(oldestKey);
	}

	const dbDir = resolve(MEMORY_DATA_DIR, "guilds", guildId);
	mkdirSync(dbDir, { recursive: true });
	const storage = new MemoryStorage(resolve(dbDir, "memory.db"));
	const episodic = new EpisodicMemory(storage);
	const instance: MemoryReadServices = {
		retrieval: new Retrieval(embedOnlyLlm, storage, episodic),
		semantic: new SemanticMemory(storage),
	};
	memoryInstances.set(guildId, instance);
	memoryStorages.set(guildId, storage);
	return instance;
}

// --- MCP Tool Call Metrics ---

const toolCallCounts = new Map<string, number>();

// 5 分ごとにログ出力
const METRICS_LOG_INTERVAL_MS = 5 * 60 * 1000;

const metricsLogTimer = setInterval(() => {
	if (toolCallCounts.size === 0) return;
	const snapshot: Record<string, number> = {};
	for (const [tool, count] of toolCallCounts) {
		snapshot[tool] = count;
	}
	logger.info(`[core-server] ${METRIC.MCP_TOOL_CALLS}:`, snapshot);
}, METRICS_LOG_INTERVAL_MS);
metricsLogTimer.unref();

// --- MCP Server Factory ---

function createServer(agentId: string | null): McpServer {
	const rawServer = new McpServer({ name: "core", version: "1.0.0" });
	const server = wrapServerWithMetrics(rawServer, toolCallCounts);

	const guildMatch = agentId?.match(/^discord:(\d+)$/);
	const boundGuildId = guildMatch?.[1];

	registerDiscordTools(server, { discordClient }, boundGuildId);
	registerScheduleTools(server, boundGuildId);
	if (agentId) {
		const memory = boundGuildId
			? { retrieval: getOrCreateMemory(boundGuildId).retrieval, guildId: boundGuildId }
			: undefined;
		const typingSender = async (channelId: string) => {
			const ch = await discordClient.channels.fetch(channelId);
			if (ch?.isTextBased() && "sendTyping" in ch) {
				await ch.sendTyping();
			}
		};
		registerEventBufferTools(server, {
			db,
			agentId,
			memory,
			moodReader: moodStore,
			moodWriter: moodStore,
			emotionAnalyzer: emotionEstimator,
			typingSender,
		});
	} else {
		logger.warn("[core-server] session created without agent_id — wait_for_events unavailable");
	}
	registerMemoryTools(server, { getOrCreateMemory }, boundGuildId);
	registerDiscordBridgeTools(server, { db }, boundGuildId);

	return rawServer;
}

// --- Start HTTP Server ---

const { cleanupTimer, closeAllSessions, stopServer } = startHttpServer(
	createServer,
	CORE_MCP_PORT,
	"core",
	logger,
);

// --- Graceful Shutdown ---

function shutdown() {
	clearInterval(metricsLogTimer);
	clearInterval(cleanupTimer);
	closeAllSessions();
	stopServer();
	discordClient.destroy();
	for (const storage of memoryStorages.values()) {
		storage.close();
	}
	memoryInstances.clear();
	memoryStorages.clear();
	closeDb(db);
	process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
