import {
	createOpencode,
	type Event,
	type EventSessionCompacted,
	type EventSessionError,
	type EventSessionIdle,
	type McpLocalConfig,
	type McpRemoteConfig,
	type OpencodeClient,
	type Part,
} from "@opencode-ai/sdk/v2";

import type {
	OpencodePromptParams,
	OpencodeSessionEvent,
	OpencodeSessionPort,
	PromptResult,
	TokenUsage,
} from "../core/types.ts";

export interface OpencodeSessionAdapterConfig {
	port: number;
	/** `{ enabled: boolean }` は SDK の設定スキーマが許容する無効化用のフォールバック型 */
	mcpServers: Record<string, McpLocalConfig | McpRemoteConfig | { enabled: boolean }>;
	builtinTools: Record<string, boolean>;
}

export class OpencodeSessionAdapter implements OpencodeSessionPort {
	private client: OpencodeClient | null = null;
	private closeServer: (() => void) | null = null;

	constructor(private readonly config: OpencodeSessionAdapterConfig) {}

	async createSession(title: string): Promise<string> {
		const oc = await this.getClient();
		const result = await oc.session.create({ title });
		if (result.error || !result.data) {
			throw new Error(
				`Failed to create session: ${result.error ? JSON.stringify(result.error) : "no data returned"}`,
			);
		}
		return result.data.id;
	}

	async sessionExists(sessionId: string): Promise<boolean> {
		const oc = await this.getClient();
		const result = await oc.session.get({ sessionID: sessionId });
		return !result.error && !!result.data;
	}

	async prompt(params: OpencodePromptParams): Promise<PromptResult> {
		const oc = await this.getClient();
		const result = await oc.session.prompt({
			sessionID: params.sessionId,
			parts: [{ type: "text", text: params.text }],
			model: { providerID: params.model.providerId, modelID: params.model.modelId },
			system: params.system,
			tools: params.tools ?? {},
		});
		if (result.error || !result.data) {
			throw new Error(`Prompt failed: ${JSON.stringify(result.error)}`);
		}
		const text = extractText(result.data.parts);
		const tokens = extractTokens(result.data.info);
		return { text, tokens };
	}

	async promptAsync(params: OpencodePromptParams): Promise<void> {
		const oc = await this.getClient();
		const result = await oc.session.promptAsync({
			sessionID: params.sessionId,
			parts: [{ type: "text", text: params.text }],
			model: { providerID: params.model.providerId, modelID: params.model.modelId },
			system: params.system,
		});
		if (result.error) {
			throw new Error(`promptAsync failed: ${JSON.stringify(result.error)}`);
		}
	}

	async waitForSessionIdle(sessionId: string, signal?: AbortSignal): Promise<OpencodeSessionEvent> {
		const oc = await this.getClient();
		const { stream } = await oc.event.subscribe();

		// messageId → latest tokens の Map（ストリーミング更新による重複防止）
		const tokensByMessage = new Map<string, TokenUsage>();

		try {
			for await (const event of stream) {
				if (signal?.aborted) return { type: "cancelled" };

				const typed = event as Event;

				// AssistantMessage のトークンを蓄積
				if (typed.type === "message.updated") {
					const info = (typed as { properties: { info: { id: string; role: string; tokens?: { input: number; output: number; cache?: { read: number } } }; sessionID?: string } }).properties.info;
					if (info.role === "assistant" && info.tokens) {
						tokensByMessage.set(info.id, {
							input: info.tokens.input,
							output: info.tokens.output,
							cacheRead: info.tokens.cache?.read ?? 0,
						});
					}
				}

				if (typed.type === "session.idle") {
					const idle = typed as EventSessionIdle;
					if (idle.properties.sessionID === sessionId) {
						const tokens = sumTokens(tokensByMessage);
						return { type: "idle", tokens };
					}
				}
				if (typed.type === "session.compacted") {
					const compacted = typed as EventSessionCompacted;
					if (compacted.properties.sessionID === sessionId) {
						return { type: "compacted" };
					}
				}
				if (typed.type === "session.error") {
					const err = typed as EventSessionError;
					if (err.properties.sessionID === sessionId) {
						return { type: "error", message: JSON.stringify(err.properties) };
					}
				}
			}
		} finally {
			// oxlint-disable-next-line no-useless-undefined -- AsyncIterator.return requires an argument
			await stream.return?.(undefined);
		}

		return { type: "idle" };
	}

	async deleteSession(sessionId: string): Promise<void> {
		const oc = await this.getClient();
		await oc.session.delete({ sessionID: sessionId });
	}

	close(): void {
		this.closeServer?.();
		this.client = null;
		this.closeServer = null;
	}

	private async getClient(): Promise<OpencodeClient> {
		if (this.client) return this.client;

		const result = await createOpencode({
			port: this.config.port,
			config: {
				mcp: this.config.mcpServers,
				tools: this.config.builtinTools,
			},
		});

		this.client = result.client;
		this.closeServer = result.server.close;
		return this.client;
	}
}

function extractText(parts: Part[]): string {
	return parts
		.filter((p): p is Part & { type: "text" } => p.type === "text")
		.map((p) => p.text)
		.join("");
}

function extractTokens(info: { tokens?: { input: number; output: number; cache?: { read: number } } }): TokenUsage | undefined {
	if (!info.tokens) return undefined;
	return {
		input: info.tokens.input,
		output: info.tokens.output,
		cacheRead: info.tokens.cache?.read ?? 0,
	};
}

function sumTokens(tokensByMessage: Map<string, TokenUsage>): TokenUsage | undefined {
	if (tokensByMessage.size === 0) return undefined;
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	for (const t of tokensByMessage.values()) {
		input += t.input;
		output += t.output;
		cacheRead += t.cacheRead;
	}
	return { input, output, cacheRead };
}
