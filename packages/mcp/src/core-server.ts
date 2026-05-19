import { mkdirSync } from "fs";
import { resolve } from "path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GeniusClient } from "@vicissitude/listening/genius-client";
import { ListeningMemory } from "@vicissitude/listening/listening-memory";
import type { MemoryReadServices } from "@vicissitude/memory";
import { EpisodicMemory } from "@vicissitude/memory/episodic";
import type { MemoryLlmPort } from "@vicissitude/memory/llm-port";
import {
	INTERNAL_NAMESPACE,
	migrateLegacyGuildMemoryNamespaces,
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
import { JsonHeartbeatConfigRepository } from "@vicissitude/scheduling/heartbeat-config";

import { LruCache } from "./lru-cache.ts";
import { MemoryInstanceCache } from "./memory-cache.ts";
import { registerListeningTools } from "./tools/listening.ts";
import { registerMemoryTools } from "./tools/memory.ts";
import { createToolDescriptionRecorder, registerMetaTools } from "./tools/meta.ts";
import { registerScheduleTools } from "./tools/schedule.ts";
import { registerSpotifyTools } from "./tools/spotify.ts";

type CoreServer = Parameters<typeof registerSpotifyTools>[0];
type CoreLogger = Parameters<typeof registerSpotifyTools>[2];

interface MediaToolEnvironment extends Record<string, string | undefined> {
	SPOTIFY_CLIENT_ID?: string;
	SPOTIFY_CLIENT_SECRET?: string;
	SPOTIFY_REFRESH_TOKEN?: string;
	SPOTIFY_RECOMMEND_PLAYLIST_ID?: string;
	GENIUS_ACCESS_TOKEN?: string;
}

interface MediaToolRegistrars {
	registerSpotify: typeof registerSpotifyTools;
	registerListening: (accessToken: string) => void;
}

function hasValue(value: string | undefined): value is string {
	return value !== undefined && value.trim().length > 0;
}

export function registerConfiguredMediaTools(
	server: CoreServer,
	env: MediaToolEnvironment,
	registrars: MediaToolRegistrars,
	logger?: CoreLogger,
): void {
	if (
		hasValue(env.SPOTIFY_CLIENT_ID) &&
		hasValue(env.SPOTIFY_CLIENT_SECRET) &&
		hasValue(env.SPOTIFY_REFRESH_TOKEN)
	) {
		registrars.registerSpotify(
			server,
			{
				clientId: env.SPOTIFY_CLIENT_ID,
				clientSecret: env.SPOTIFY_CLIENT_SECRET,
				refreshToken: env.SPOTIFY_REFRESH_TOKEN,
				recommendPlaylistId: env.SPOTIFY_RECOMMEND_PLAYLIST_ID,
			},
			logger,
		);
	}

	if (hasValue(env.GENIUS_ACCESS_TOKEN)) {
		registrars.registerListening(env.GENIUS_ACCESS_TOKEN);
	}
}

/**
 * core MCP サーバーのエントリポイント（stdio モード）。
 *
 * OpenCode が子プロセスとして起動し、stdin/stdout で MCP 通信を行う。
 * エージェントごとに1プロセスが生成されるため、AGENT_ID 環境変数で
 * 自分がどの agentId にバインドされているかを知る。
 *
 */
async function main(): Promise<void> {
	const logger = new ConsoleLogger({ destination: "stderr" });

	// --- Configuration from environment ---

	const AGENT_ID = process.env.AGENT_ID;
	if (!AGENT_ID) {
		logger.error("[core-server] AGENT_ID environment variable is required");
		process.exit(1);
	}

	const MEMORY_OLLAMA_BASE_URL =
		process.env.MEMORY_OLLAMA_BASE_URL ?? process.env.OLLAMA_BASE_URL ?? "http://ollama:11434";
	const MEMORY_EMBEDDING_MODEL = process.env.MEMORY_EMBEDDING_MODEL ?? "embeddinggemma";
	const MEMORY_DATA_DIR = process.env.MEMORY_DATA_DIR ?? "data/memory";
	const DATA_DIR = process.env.DATA_DIR ?? "data";
	const configRepo = new JsonHeartbeatConfigRepository(resolve(DATA_DIR, "heartbeat-config.json"));
	migrateLegacyGuildMemoryNamespaces(MEMORY_DATA_DIR);

	// --- Memory (embed-only — consolidation runs in the main process) ---

	const ollama = new OllamaEmbeddingAdapter(MEMORY_OLLAMA_BASE_URL, MEMORY_EMBEDDING_MODEL);

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
	const { server: toolServer, toolDescriptions } = createToolDescriptionRecorder(server);

	const boundNamespace: MemoryNamespace | undefined =
		resolveNamespaceFromAgentId(AGENT_ID) ?? undefined;
	if (!boundNamespace) {
		logger.warn(
			`[core-server] AGENT_ID=${AGENT_ID} did not resolve to a known namespace — tools require explicit scope_id`,
		);
	}
	const boundScopeId =
		boundNamespace?.surface === "agent-scope" ? boundNamespace.scopeId : undefined;

	registerScheduleTools(toolServer, configRepo, boundScopeId);

	const retrieveCache = new LruCache<{ content: Array<{ type: "text"; text: string }> }>({
		ttlMs: 30 * 60 * 1_000,
		maxSize: 100,
	});
	registerMemoryTools(toolServer, { getOrCreateMemory, cache: retrieveCache }, boundNamespace);

	registerConfiguredMediaTools(
		toolServer,
		process.env,
		{
			registerSpotify: registerSpotifyTools,
			registerListening: (accessToken) => {
				const geniusClient = new GeniusClient(accessToken);
				memoryCache.getOrCreate(INTERNAL_NAMESPACE);
				const internalStorage = memoryCache.getStorage(INTERNAL_NAMESPACE);
				if (!internalStorage)
					throw new Error("unreachable: getOrCreate failed to populate memoryCache");
				const listeningMemory = new ListeningMemory(internalStorage, {
					embed: (text) => ollama.embed(text),
				});
				registerListeningTools(toolServer, {
					fetchLyrics: (title, artist) => geniusClient.fetchLyrics(title, artist),
					saveListening: async (record) => {
						await listeningMemory.saveListening({
							track: record.track,
							impression: record.impression,
							listenedAt: record.listenedAt,
						});
					},
				});
			},
		},
		logger,
	);

	registerMetaTools(toolServer, toolDescriptions);

	// --- Graceful Shutdown ---

	async function shutdown() {
		await server.close();
		retrieveCache.dispose();
		memoryCache.closeAll();
		process.exit(0);
	}

	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());

	// --- Start server (stdio) ---

	const transport = new StdioServerTransport();
	await server.connect(transport);
}

if (import.meta.main) {
	void main();
}
