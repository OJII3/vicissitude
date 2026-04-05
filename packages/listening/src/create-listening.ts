import type { MemoryLlmPort } from "@vicissitude/memory/llm-port";
import type { MemoryStorage } from "@vicissitude/memory/storage";

import { GeniusClient } from "./genius-client.ts";
import { ListeningLlmAdapter } from "./listening-llm-adapter.ts";
import { ListeningMemory } from "./listening-memory.ts";
import { ListeningService } from "./listening-service.ts";

export interface CreateListeningParams {
	geniusAccessToken: string;
	memoryLlm: MemoryLlmPort;
	storage: MemoryStorage;
}

export interface ListeningFacade {
	service: ListeningService;
}

/** composition-root 配線: 歌詞取得 + LLM + Memory 保存を結線した ListeningService を返す */
export function createListening(params: CreateListeningParams): ListeningFacade {
	const lyrics = new GeniusClient(params.geniusAccessToken);
	const llm = new ListeningLlmAdapter(params.memoryLlm);
	const memory = new ListeningMemory(params.storage, llm);
	const service = new ListeningService(lyrics, llm, memory);
	return { service };
}
