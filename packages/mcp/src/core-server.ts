import { mkdirSync } from "fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EmotionEstimator } from "@vicissitude/agent/emotion/estimator";
import { GeniusClient } from "@vicissitude/listening/genius-client";
import { ListeningMemory } from "@vicissitude/listening/listening-memory";
import { EpisodicMemory } from "@vicissitude/memory/episodic";
import type { MemoryLlmPort } from "@vicissitude/memory/llm-port";
import {
	INTERNAL_NAMESPACE,
	type MemoryNamespace,
	namespaceKey,
	resolveMemoryDbDir,
	resolveMemoryDbPath,
	resolveNamespaceFromAgentId,
} from "@vicissitude/memory/namespace";
import { Retrieval } from "@vicissitude/memory/retrieval";
import { SemanticMemory } from "@vicissitude/memory/semantic-memory";
import { MemoryStorage } from "@vicissitude/memory/storage";
import { ConsoleLogger } from "@vicissitude/observability/logger";
import { METRIC, PrometheusCollector, PrometheusServer } from "@vicissitude/observability/metrics";
import { OllamaEmbeddingAdapter } from "@vicissitude/ollama";
import { OllamaChatAdapter } from "@vicissitude/ollama/ollama-chat-adapter";
import { closeDb, createDb } from "@vicissitude/store/db";
import { SqliteMoodStore } from "@vicissitude/store/mood-store";
import { Client, GatewayIntentBits } from "discord.js";

import { startHttpServer } from "./http-server.ts";
import { wrapServerWithMetrics } from "./tool-metrics.ts";
import { registerDiscordTools } from "./tools/discord.ts";
import { createSkipTracker, registerEventBufferTools } from "./tools/event-buffer.ts";
import { registerListeningTools } from "./tools/listening.ts";
import { registerDiscordBridgeTools } from "./tools/mc-bridge-discord.ts";
import { type MemoryReadServices, registerMemoryTools } from "./tools/memory.ts";
import { registerScheduleTools } from "./tools/schedule.ts";
import { registerSpotifyTools } from "./tools/spotify.ts";

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
		GatewayIntentBits.GuildMessageReactions,
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

function getOrCreateMemory(namespace: MemoryNamespace): MemoryReadServices {
	const key = namespaceKey(namespace);

	const existing = memoryInstances.get(key);
	if (existing) {
		// LRU: 再挿入して最新アクセスとして記録
		memoryInstances.delete(key);
		memoryInstances.set(key, existing);
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

	const dbDir = resolveMemoryDbDir(MEMORY_DATA_DIR, namespace);
	mkdirSync(dbDir, { recursive: true });
	const storage = new MemoryStorage(resolveMemoryDbPath(MEMORY_DATA_DIR, namespace));
	const episodic = new EpisodicMemory(storage);
	const instance: MemoryReadServices = {
		retrieval: new Retrieval(embedOnlyLlm, storage, episodic),
		semantic: new SemanticMemory(storage),
	};
	memoryInstances.set(key, instance);
	memoryStorages.set(key, storage);
	return instance;
}

// --- Prometheus Metrics ---

const CORE_METRICS_PORT = Number(process.env.CORE_METRICS_PORT) || 9093;

const metricsCollector = new PrometheusCollector();
metricsCollector.registerCounter(METRIC.MCP_TOOL_CALLS, "Core MCP tool calls total");

const metricsServer = new PrometheusServer(metricsCollector, logger, CORE_METRICS_PORT);
metricsServer.start();

// --- MCP Server Factory ---

function createServer(agentId: string | null): McpServer {
	const rawServer = new McpServer({ name: "core", version: "1.0.0" });
	const server = wrapServerWithMetrics(rawServer, { metrics: metricsCollector, logger });

	const boundNamespace = resolveNamespaceFromAgentId(agentId) ?? undefined;
	if (agentId && !boundNamespace) {
		logger.warn(
			`[core-server] agent_id=${agentId} did not resolve to a known namespace — tools require explicit guild_id`,
		);
	}
	const boundGuildId =
		boundNamespace?.surface === "discord-guild" ? boundNamespace.guildId : undefined;
	const moodKey = boundGuildId ? `discord:${boundGuildId}` : (agentId ?? undefined);
	const skipTracker = agentId ? createSkipTracker() : undefined;

	registerDiscordTools(
		server,
		{
			discordClient,
			emotionAnalyzer: emotionEstimator,
			moodWriter: moodStore,
			agentId: agentId ?? undefined,
			moodKey,
			skipTracker,
		},
		boundGuildId,
	);
	registerScheduleTools(server, boundGuildId);
	if (agentId) {
		const recentMessagesFetcher = async (channelId: string) => {
			const ch = await discordClient.channels.fetch(channelId);
			if (!ch?.isTextBased() || !("messages" in ch)) return [];
			const msgs = await ch.messages.fetch({ limit: 5 });
			return [...msgs.values()].map((m) => ({
				authorName: m.member?.displayName ?? m.author.displayName,
				content: m.content,
				timestamp: m.createdAt,
				reactions: [...m.reactions.cache.values()].map((r) => ({
					emoji: r.emoji.name ?? r.emoji.toString(),
					count: r.count,
				})),
			}));
		};
		registerEventBufferTools(server, {
			db,
			agentId,
			moodKey,
			recentMessagesFetcher,
			moodReader: moodStore,
			logger,
			skipTracker,
		});
	} else {
		logger.warn("[core-server] session created without agent_id — wait_for_events unavailable");
	}
	registerMemoryTools(server, { getOrCreateMemory }, boundNamespace);
	registerDiscordBridgeTools(server, { db }, boundGuildId);

	if (
		process.env.SPOTIFY_CLIENT_ID &&
		process.env.SPOTIFY_CLIENT_SECRET &&
		process.env.SPOTIFY_REFRESH_TOKEN
	) {
		registerSpotifyTools(
			server,
			{
				clientId: process.env.SPOTIFY_CLIENT_ID,
				clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
				refreshToken: process.env.SPOTIFY_REFRESH_TOKEN,
				recommendPlaylistId: process.env.SPOTIFY_RECOMMEND_PLAYLIST_ID,
			},
			logger,
		);

		if (process.env.GENIUS_ACCESS_TOKEN) {
			const geniusClient = new GeniusClient(process.env.GENIUS_ACCESS_TOKEN);
			// internal namespace の MemoryStorage を確保
			getOrCreateMemory(INTERNAL_NAMESPACE);
			const internalStorage = memoryStorages.get(namespaceKey(INTERNAL_NAMESPACE));
			if (internalStorage) {
				const listeningMemory = new ListeningMemory(internalStorage, {
					embed: (text) => ollama.embed(text),
				});
				registerListeningTools(server, {
					fetchLyrics: (title, artist) => geniusClient.fetchLyrics(title, artist),
					saveListening: async (record) => {
						await listeningMemory.saveListening({
							track: record.track,
							impression: record.impression,
							listenedAt: record.listenedAt,
						});
					},
				});
			}
		}
	}

	return server;
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
	metricsServer.stop();
	clearInterval(cleanupTimer);
	closeAllSessions();
	stopServer();
	void discordClient.destroy();
	for (const storage of memoryStorages.values()) {
		storage.close();
	}
	memoryInstances.clear();
	memoryStorages.clear();
	closeDb(db);
	process.exit(0);
}

process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());
