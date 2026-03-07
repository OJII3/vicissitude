import type { ChatMessage, LLMPort, Schema } from "fenghuang";

import type { OllamaEmbeddingAdapter } from "../ollama/ollama-embedding-adapter.ts";
import type { OpencodeChatAdapter } from "../opencode/opencode-chat-adapter.ts";

/** Composite LLMPort: chat/chatStructured via OpenCode, embed via Ollama */
export class CompositeLLMAdapter implements LLMPort {
	constructor(
		private readonly chatAdapter: OpencodeChatAdapter,
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
