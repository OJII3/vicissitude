import type { ChatMessage } from "./types.ts";

/** Schema definition for structured output */
export interface Schema<T> {
	parse(data: unknown): T;
}

/** Memory LLM Port — Core depends only on this interface */
export interface MemoryLlmPort {
	/** Free-form chat response */
	chat(messages: ChatMessage[]): Promise<string>;
	/** Structured output (JSON Schema compliant) */
	chatStructured<T>(messages: ChatMessage[], schema: Schema<T>): Promise<T>;
	/** Generate embedding vector for text */
	embed(text: string): Promise<number[]>;
}
