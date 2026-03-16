import type { OllamaEmbeddingAdapter } from "@vicissitude/ollama";
import type { LtmLlmPort, Schema } from "./llm-port.ts";
import type { LtmChatAdapter } from "./ltm-chat-adapter.ts";
import type { ChatMessage } from "./types.ts";

/** Composite LtmLlmPort: chat/chatStructured via OpenCode, embed via Ollama */
export class CompositeLLMAdapter implements LtmLlmPort {
	constructor(
		private readonly chatAdapter: LtmChatAdapter,
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
