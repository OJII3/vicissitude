import type { OllamaEmbeddingAdapter } from "@vicissitude/ollama";

import type { MemoryChatAdapter } from "./chat-adapter.ts";
import type { MemoryLlmPort, Schema } from "./llm-port.ts";
import type { ChatMessage } from "./types.ts";

/** Composite MemoryLlmPort: chat/chatStructured via OpenCode, embed via Ollama */
export class CompositeLLMAdapter implements MemoryLlmPort {
	constructor(
		private readonly chatAdapter: MemoryChatAdapter,
		private readonly embeddingAdapter: OllamaEmbeddingAdapter,
	) {}

	chat(messages: ChatMessage[]): Promise<string> {
		return this.chatAdapter.chat(messages);
	}

	chatStructured<T>(messages: ChatMessage[], schema: Schema<T>): Promise<T> {
		return this.chatAdapter.chatStructured(messages, schema);
	}

	embed(text: string): Promise<number[]> {
		return this.embeddingAdapter.embed(text);
	}
}
