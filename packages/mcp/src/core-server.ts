import { mkdirSync } from "fs";
import { resolve } from "path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { MemoryReadServices } from "@vicissitude/memory";
import { EpisodicMemory } from "@vicissitude/memory/episodic";
import type { MemoryLlmPort } from "@vicissitude/memory/llm-port";
import {
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
import { registerMemoryTools } from "./tools/memory.ts";
import { createToolDescriptionRecorder, registerMetaTools } from "./tools/meta.ts";
import { registerScheduleTools } from "./tools/schedule.ts";

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
