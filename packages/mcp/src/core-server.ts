import { mkdirSync } from "fs";
import { resolve } from "path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EpisodicMemory } from "@vicissitude/ltm/episodic";
import type { LtmLlmPort } from "@vicissitude/ltm/llm-port";
import { LtmStorage } from "@vicissitude/ltm/ltm-storage";
import { Retrieval } from "@vicissitude/ltm/retrieval";
import { SemanticMemory } from "@vicissitude/ltm/semantic-memory";
import { ConsoleLogger } from "@vicissitude/observability/logger";
import { OllamaEmbeddingAdapter } from "@vicissitude/ollama";
import { METRIC } from "@vicissitude/shared/constants";
import { closeDb, createDb } from "@vicissitude/store/db";
import { Client, GatewayIntentBits } from "discord.js";

import { startHttpServer } from "./http-server.ts";
import { wrapServerWithMetrics } from "./tool-metrics.ts";
import { registerDiscordTools } from "./tools/discord.ts";
import { registerEventBufferTools } from "./tools/event-buffer.ts";
import { type LtmReadServices, registerLtmTools } from "./tools/ltm.ts";
import { registerDiscordBridgeTools } from "./tools/mc-bridge-discord.ts";
import { registerMemoryTools } from "./tools/memory.ts";
import { registerScheduleTools } from "./tools/schedule.ts";

// --- Logger ---

const logger = new ConsoleLogger();

// --- Configuration from environment ---

const CORE_MCP_PORT = Number(process.env.CORE_MCP_PORT ?? "4095");
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://ollama:11434";
const LTM_EMBEDDING_MODEL = process.env.LTM_EMBEDDING_MODEL ?? "embeddinggemma";
const LTM_DATA_DIR = process.env.LTM_DATA_DIR ?? "data/ltm";
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

// --- LTM (embed-only — consolidation runs in the main process) ---

const ollama = new OllamaEmbeddingAdapter(OLLAMA_BASE_URL, LTM_EMBEDDING_MODEL);

/** LtmLlmPort that only supports embed — chat/chatStructured throw since they are unused here */
const embedOnlyLlm: LtmLlmPort = {
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

const MAX_LTM_INSTANCES = 50;

const ltmInstances = new Map<string, LtmReadServices>();
const ltmStorages = new Map<string, LtmStorage>();

const GUILD_ID_REGEX = /^\d+$/;

function getOrCreateLtm(guildId: string): LtmReadServices {
	if (!GUILD_ID_REGEX.test(guildId)) {
		throw new Error(`Invalid guildId: ${guildId}`);
	}

	const existing = ltmInstances.get(guildId);
	if (existing) {
		// LRU: 再挿入して最新アクセスとして記録
		ltmInstances.delete(guildId);
		ltmInstances.set(guildId, existing);
		return existing;
	}

	// Evict oldest entry if at capacity
	if (ltmInstances.size >= MAX_LTM_INSTANCES) {
		const oldestKey = ltmInstances.keys().next().value as string;
		ltmInstances.delete(oldestKey);
		const oldStorage = ltmStorages.get(oldestKey);
		oldStorage?.close();
		ltmStorages.delete(oldestKey);
	}

	const dbDir = resolve(LTM_DATA_DIR, "guilds", guildId);
	mkdirSync(dbDir, { recursive: true });
	const storage = new LtmStorage(resolve(dbDir, "memory.db"));
	const episodic = new EpisodicMemory(storage);
	const instance: LtmReadServices = {
		retrieval: new Retrieval(embedOnlyLlm, storage, episodic),
		semantic: new SemanticMemory(storage),
	};
	ltmInstances.set(guildId, instance);
	ltmStorages.set(guildId, storage);
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

function createServer(): McpServer {
	const rawServer = new McpServer({ name: "core", version: "1.0.0" });
	const server = wrapServerWithMetrics(rawServer, toolCallCounts);

	registerDiscordTools(server, { discordClient });
	registerMemoryTools(server);
	registerScheduleTools(server);
	registerEventBufferTools(server, { db });
	registerLtmTools(server, { getOrCreateLtm });
	registerDiscordBridgeTools(server, { db });

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
	for (const storage of ltmStorages.values()) {
		storage.close();
	}
	ltmInstances.clear();
	ltmStorages.clear();
	closeDb(db);
	process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
