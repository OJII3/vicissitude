import type { ChatMessage } from "fenghuang";

import type { OpencodeSessionPort } from "../core/types.ts";

const JSON_INSTRUCTION =
	"IMPORTANT: Respond ONLY with valid JSON. No markdown, no code fences, no explanation.";

interface Schema<T> {
	parse(data: unknown): T;
}

/** Adapter that uses OpencodeSessionPort for fenghuang chat / chatStructured */
export class FenghuangChatAdapter {
	constructor(
		private readonly sessionPort: OpencodeSessionPort,
		private readonly providerId: string,
		private readonly modelId: string,
	) {}

	async chat(messages: ChatMessage[]): Promise<string> {
		const { system, userContent } = separateMessages(messages);

		const sessionId = await this.sessionPort.createSession("fenghuang-chat");

		try {
			return await this.sessionPort.prompt({
				sessionId,
				text: userContent,
				model: { providerId: this.providerId, modelId: this.modelId },
				system,
				tools: {},
			});
		} finally {
			try {
				await this.sessionPort.deleteSession(sessionId);
			} catch (e) {
				console.error("Failed to delete session:", e);
			}
		}
	}

	async chatStructured<T>(messages: ChatMessage[], schema: Schema<T>): Promise<T> {
		const augmented = appendJsonInstruction(messages);
		const text = await this.chat(augmented);
		const cleaned = cleanJsonResponse(text);

		let parsed: unknown;
		try {
			parsed = JSON.parse(cleaned);
		} catch {
			throw new Error(`LLM response was not valid JSON: ${text.slice(0, 200)}`);
		}
		return schema.parse(parsed);
	}

	close(): void {
		this.sessionPort.close();
	}
}

export function separateMessages(messages: ChatMessage[]): {
	system: string | undefined;
	userContent: string;
} {
	const systemParts: string[] = [];
	const userParts: string[] = [];

	for (const msg of messages) {
		if (msg.role === "system") {
			systemParts.push(msg.content);
		} else {
			userParts.push(`${msg.role}: ${msg.content}`);
		}
	}

	return {
		system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
		userContent: userParts.join("\n"),
	};
}

export function appendJsonInstruction(messages: ChatMessage[]): ChatMessage[] {
	const augmented = [...messages];
	const lastIdx = augmented.length - 1;
	const lastMsg = augmented[lastIdx];
	if (lastIdx >= 0 && lastMsg && lastMsg.role === "user") {
		augmented[lastIdx] = { ...lastMsg, content: `${lastMsg.content}\n\n${JSON_INSTRUCTION}` };
	}
	return augmented;
}

export function cleanJsonResponse(text: string): string {
	const trimmed = text.trim();
	const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
	if (fenceMatch?.[1]) {
		return fenceMatch[1].trim();
	}
	return trimmed;
}
