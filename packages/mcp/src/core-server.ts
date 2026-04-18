import { mkdirSync } from "fs";
import { resolve } from "path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EmotionEstimator } from "@vicissitude/agent/emotion/estimator";
import { HttpImageFetcher } from "@vicissitude/infrastructure/http/image-fetcher";
import { GeniusClient } from "@vicissitude/listening/genius-client";
import { ListeningMemory } from "@vicissitude/listening/listening-memory";
import type { MemoryReadServices } from "@vicissitude/memory";
import { EpisodicMemory } from "@vicissitude/memory/episodic";
import type { MemoryLlmPort } from "@vicissitude/memory/llm-port";
import {
	INTERNAL_NAMESPACE,
	type MemoryNamespace,
	resolveMemoryDbDir,
	resolveMemoryDbPath,
	resolveNamespaceFromAgentId,
} from "@vicissitude/memory/namespace";
import { Retrieval } from "@vicissitude/memory/retrieval";
import { SemanticMemory } from "@vicissitude/memory/semantic-memory";
import { MemoryStorage } from "@vicissitude/memory/storage";
import { ConsoleLogger } from "@vicissitude/observability/logger";
import { OllamaEmbeddingAdapter } from "@vicissitude/ollama";
import { OllamaChatAdapter } from "@vicissitude/ollama/ollama-chat-adapter";
import { JsonHeartbeatConfigRepository } from "@vicissitude/scheduling/heartbeat-config";
import { closeDb, createDb } from "@vicissitude/store/db";
import { SqliteMoodStore } from "@vicissitude/store/mood-store";
import { Client } from "discord.js";

import { LruCache } from "./lru-cache.ts";
import { MemoryInstanceCache } from "./memory-cache.ts";
import { registerDiscordTools } from "./tools/discord.ts";
import { registerEventBufferTools } from "./tools/event-buffer.ts";
import { registerListeningTools } from "./tools/listening.ts";
import { registerDiscordBridgeTools } from "./tools/mc-bridge-discord.ts";
import { registerMemoryTools } from "./tools/memory.ts";
import { registerMetaTools } from "./tools/meta.ts";
import { registerScheduleTools } from "./tools/schedule.ts";
import { registerSpotifyTools } from "./tools/spotify.ts";

/**
 * core MCP サーバーのエントリポイント（stdio モード）。
 *
 * OpenCode が子プロセスとして起動し、stdin/stdout で MCP 通信を行う。
 * エージェントごとに1プロセスが生成されるため、AGENT_ID 環境変数で
 * 自分がどの agentId にバインドされているかを知る。
 *
 * @see {@link ./tools/event-buffer.ts} — ポーリングモデルの詳細
 */
async function main(): Promise<void> {
	const logger = new ConsoleLogger({ destination: "stderr" });

	// --- Configuration from environment ---

	const AGENT_ID = process.env.AGENT_ID;
	if (!AGENT_ID) {
		logger.error("[core-server] AGENT_ID environment variable is required");
		process.exit(1);
	}

	const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://ollama:11434";
	const MEMORY_EMBEDDING_MODEL = process.env.MEMORY_EMBEDDING_MODEL ?? "embeddinggemma";
	const MEMORY_DATA_DIR = process.env.MEMORY_DATA_DIR ?? "data/memory";
	const EMOTION_CHAT_MODEL = process.env.EMOTION_CHAT_MODEL ?? "gemma3";
	const DATA_DIR = process.env.DATA_DIR ?? "data";
	const configRepo = new JsonHeartbeatConfigRepository(resolve(DATA_DIR, "heartbeat-config.json"));

	if (!process.env.DISCORD_TOKEN) {
		logger.error("[core-server] DISCORD_TOKEN environment variable is required");
		process.exit(1);
	}

	// --- Discord Client (REST-only, no Gateway connection) ---
	// MCP ツールは REST API のみ使用し、Gateway イベントは不要。
	// login() を呼ばないことで Gateway セッションの生成を回避する。

	const discordClient = new Client({ intents: [] });
	discordClient.token = process.env.DISCORD_TOKEN;
	discordClient.rest.setToken(process.env.DISCORD_TOKEN);

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

	const memoryCache = new MemoryInstanceCache(50, (namespace) => {
		const dbDir = resolveMemoryDbDir(MEMORY_DATA_DIR, namespace);
		mkdirSync(dbDir, { recursive: true });
		const storage = new MemoryStorage(resolveMemoryDbPath(MEMORY_DATA_DIR, namespace));
		const episodic = new EpisodicMemory(storage);
		const instance: MemoryReadServices = {
			retrieval: new Retrieval(embedOnlyLlm, storage, episodic),
			semantic: new SemanticMemory(storage),
		};
		return { instance, storage };
	});

	function getOrCreateMemory(namespace: MemoryNamespace): MemoryReadServices {
		return memoryCache.getOrCreate(namespace);
	}

	// --- MCP Server ---

	const server = new McpServer({ name: "core", version: "1.0.0" });
	const toolDescriptions = new Map<string, string | undefined>();

	const boundNamespace: MemoryNamespace | undefined =
		resolveNamespaceFromAgentId(AGENT_ID) ?? undefined;
	if (!boundNamespace) {
		logger.warn(
			`[core-server] AGENT_ID=${AGENT_ID} did not resolve to a known namespace — tools require explicit guild_id`,
		);
	}
	const boundGuildId =
		boundNamespace?.surface === "discord-guild" ? boundNamespace.guildId : undefined;
	const moodKey = boundGuildId ? `discord:${boundGuildId}` : AGENT_ID;

	registerDiscordTools(
		server,
		{
			discordClient,
			emotionAnalyzer: emotionEstimator,
			moodWriter: moodStore,
			agentId: AGENT_ID,
			moodKey,
		},
		boundGuildId,
	);
	registerScheduleTools(server, configRepo, boundGuildId);

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
		agentId: AGENT_ID,
		moodKey,
		recentMessagesFetcher,
		moodReader: moodStore,
		logger,
		imageFetcher: new HttpImageFetcher({ logger }),
	});

	const retrieveCache = new LruCache<{ content: Array<{ type: "text"; text: string }> }>({
		ttlMs: 30 * 60 * 1_000,
		maxSize: 100,
	});
	registerMemoryTools(server, { getOrCreateMemory, cache: retrieveCache }, boundNamespace);
	if (process.env.MC_HOST) {
		registerDiscordBridgeTools(server, { db }, boundGuildId);
	}

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
			memoryCache.getOrCreate(INTERNAL_NAMESPACE);
			const internalStorage = memoryCache.getStorage(INTERNAL_NAMESPACE);
			if (!internalStorage)
				throw new Error("unreachable: getOrCreate failed to populate memoryCache");
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

	registerMetaTools(server, toolDescriptions);

	// --- Graceful Shutdown ---

	async function shutdown() {
		await server.close();
		void discordClient.destroy();
		retrieveCache.dispose();
		memoryCache.closeAll();
		closeDb(db);
		process.exit(0);
	}

	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());

	// --- Start server (stdio) ---

	const transport = new StdioServerTransport();
	await server.connect(transport);
}

void main();
