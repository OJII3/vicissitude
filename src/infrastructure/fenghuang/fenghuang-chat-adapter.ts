import { createOpencode, type OpencodeClient, type Part } from "@opencode-ai/sdk/v2";
import type { ChatMessage } from "fenghuang";

const JSON_INSTRUCTION =
	"IMPORTANT: Respond ONLY with valid JSON. No markdown, no code fences, no explanation.";

interface Schema<T> {
	parse(data: unknown): T;
}

/** Adapter that uses OpenCode SDK for fenghuang chat / chatStructured */
export class FenghuangChatAdapter {
	private client: OpencodeClient | null = null;
	private closeServer: (() => void) | null = null;

	constructor(
		private readonly port: number,
		private readonly modelId: string,
	) {}

	async initialize(): Promise<void> {
		const result = await createOpencode({
			port: this.port,
			config: {
				mcp: {},
				tools: {
					question: false,
					read: false,
					glob: false,
					grep: false,
					edit: false,
					write: false,
					bash: false,
					webfetch: false,
					websearch: false,
					task: false,
					todowrite: false,
					skill: false,
				},
			},
		});
		this.client = result.client;
		this.closeServer = result.server.close;
	}

	async chat(messages: ChatMessage[]): Promise<string> {
		const oc = this.getClient();
		const { system, userContent } = separateMessages(messages);

		const session = await oc.session.create({ title: "fenghuang-chat" });
		if (session.error || !session.data) {
			throw new Error(`Failed to create session: ${JSON.stringify(session.error)}`);
		}
		const sessionId = session.data.id;

		try {
			const result = await oc.session.prompt({
				sessionID: sessionId,
				parts: [{ type: "text", text: userContent }],
				model: { providerID: "github-copilot", modelID: this.modelId },
				system,
				tools: {},
			});

			if (result.error || !result.data) {
				throw new Error(`Prompt failed: ${JSON.stringify(result.error)}`);
			}

			return extractText(result.data.parts);
		} finally {
			try {
				await oc.session.delete({ sessionID: sessionId });
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
		this.closeServer?.();
		this.client = null;
		this.closeServer = null;
	}

	private getClient(): OpencodeClient {
		if (!this.client) {
			throw new Error("FenghuangChatAdapter not initialized — call initialize() first");
		}
		return this.client;
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

export function extractText(parts: Part[]): string {
	return parts
		.filter((p): p is Part & { type: "text" } => p.type === "text")
		.map((p) => p.text)
		.join("");
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
