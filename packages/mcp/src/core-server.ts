import { mkdirSync } from "fs";
import { resolve } from "path";

import type { MemoryReadServices } from "@vicissitude/memory";
import type { MemoryLlmPort } from "@vicissitude/memory/llm-port";
import {
	migrateLegacyGuildMemoryNamespaces,
	type MemoryNamespace,
	resolveMemoryDbDir,
	resolveMemoryDbPath,
} from "@vicissitude/memory/namespace";
import { Retrieval } from "@vicissitude/memory/retrieval";
import { SemanticMemory } from "@vicissitude/memory/semantic-memory";
import { MemoryStorage } from "@vicissitude/memory/storage";
import { OllamaEmbeddingAdapter } from "@vicissitude/ollama";
import { JsonHeartbeatConfigRepository } from "@vicissitude/scheduling/heartbeat-config";

import { LruCache } from "./lru-cache.ts";
import { MemoryInstanceCache } from "./memory-cache.ts";
import { runStdioMcpServer, type StdioMcpServerContext } from "./run-stdio-mcp-server.ts";
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
function setup(ctx: StdioMcpServerContext): () => void {
	// --- Configuration from environment ---

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
		const instance: MemoryReadServices = {
			retrieval: new Retrieval(embedOnlyLlm, storage),
			semantic: new SemanticMemory(storage),
		};
		return { instance, storage };
	});

	function getOrCreateMemory(namespace: MemoryNamespace): MemoryReadServices {
		return memoryCache.getOrCreate(namespace);
	}

	// --- MCP Server ---

	const { server: toolServer, toolDescriptions } = createToolDescriptionRecorder(ctx.server);

	registerScheduleTools(toolServer, configRepo, ctx.boundScopeId);

	const retrieveCache = new LruCache<{ content: Array<{ type: "text"; text: string }> }>({
		ttlMs: 30 * 60 * 1_000,
		maxSize: 100,
	});
	registerMemoryTools(toolServer, { getOrCreateMemory, cache: retrieveCache }, ctx.boundNamespace);

	registerMetaTools(toolServer, toolDescriptions);

	// --- Graceful Shutdown (helper calls this after server.close()) ---

	return () => {
		retrieveCache.dispose();
		memoryCache.closeAll();
	};
}

if (import.meta.main) {
	void runStdioMcpServer({
		name: "core",
		version: "1.0.0",
		missingScopeHint: "scope_id",
		setup,
	});
}
