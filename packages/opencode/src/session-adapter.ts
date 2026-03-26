import {
	createOpencode,
	type Event,
	type McpLocalConfig,
	type McpRemoteConfig,
	type OpencodeClient,
} from "@opencode-ai/sdk/v2";
import type {
	Logger,
	OpencodePromptParams,
	OpencodeSessionEvent,
	OpencodeSessionPort,
	PromptResult,
	TokenUsage,
} from "@vicissitude/shared/types";

import {
	abortSession,
	classifyEvent,
	extractText,
	extractTokens,
	nextStreamEvent,
	returnStreamOnce,
	sumTokens,
} from "./stream-helpers.ts";

const SESSION_SUMMARY_PROMPT = `あなたはセッション要約アシスタントです。
この会話セッションの内容を、次のセッションに引き継ぐための要約を日本語で作成してください。

以下の情報を含めてください:
- 主要な話題・やりとりの流れ
- ユーザーの感情状態・トーンの傾向
- 未解決の話題や継続中の文脈
- 重要な約束や決定事項

簡潔かつ情報密度の高い要約にしてください（500文字以内）。
ツールは使用しないでください。`;

export interface OpencodeSessionAdapterConfig {
	port: number;
	/** `{ enabled: boolean }` は SDK の設定スキーマが許容する無効化用のフォールバック型 */
	mcpServers: Record<string, McpLocalConfig | McpRemoteConfig | { enabled: boolean }>;
	builtinTools: Record<string, boolean>;
	temperature?: number;
	clientFactory?: typeof createOpencode;
	logger?: Logger;
}

export class OpencodeSessionAdapter implements OpencodeSessionPort {
	private client: OpencodeClient | null = null;
	private closeServer: (() => void) | null = null;
	private readonly logger?: Logger;
	constructor(private readonly config: OpencodeSessionAdapterConfig) {
		this.logger = config.logger;
	}
	async createSession(title: string): Promise<string> {
		this.logger?.info(`[opencode] creating session: ${title}`);
		const oc = await this.getClient();
		const result = await oc.session.create({ title });
		if (result.error || !result.data) {
			throw new Error(
				`Failed to create session: ${result.error ? JSON.stringify(result.error) : "no data returned"}`,
			);
		}
		this.logger?.info(`[opencode] session created: ${result.data.id}`);
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

	async promptAsyncAndWatchSession(
		params: OpencodePromptParams,
		signal?: AbortSignal,
	): Promise<OpencodeSessionEvent> {
		this.logger?.info(
			`[opencode] promptAsyncAndWatch: session=${params.sessionId} model=${params.model.providerId}/${params.model.modelId}`,
		);
		const oc = await this.getClient();
		const { stream } = await oc.event.subscribe();
		this.logger?.info("[opencode] event stream subscribed");
		const tokensByMessage = new Map<string, TokenUsage>();
		try {
			const result = await oc.session.promptAsync({
				sessionID: params.sessionId,
				parts: [{ type: "text", text: params.text }],
				model: { providerID: params.model.providerId, modelID: params.model.modelId },
				system: params.system,
			});
			if (result.error) {
				throw new Error(`promptAsync failed: ${JSON.stringify(result.error)}`);
			}
			this.logger?.info("[opencode] promptAsync sent, watching events...");

			while (true) {
				// eslint-disable-next-line no-await-in-loop -- event stream must be consumed sequentially
				const event = await nextStreamEvent(stream, signal, () =>
					abortSession(oc, params.sessionId),
				);
				if (event.type === "aborted") {
					this.logger?.info("[opencode] event stream aborted");
					return { type: "cancelled" };
				}
				if (event.type === "done") {
					this.logger?.info("[opencode] event stream done (idle)");
					return { type: "idle", tokens: sumTokens(tokensByMessage) };
				}
				const typed = event.value as Event;
				const classified = classifyEvent(typed, params.sessionId, tokensByMessage);
				if (classified) {
					this.logger?.info(`[opencode] session event: ${classified.type}`);
					return classified;
				}
			}
		} finally {
			await returnStreamOnce(stream);
		}
		return { type: "idle" };
	}
	async waitForSessionIdle(sessionId: string, signal?: AbortSignal): Promise<OpencodeSessionEvent> {
		const oc = await this.getClient();
		const { stream } = await oc.event.subscribe();
		const tokensByMessage = new Map<string, TokenUsage>();
		try {
			while (true) {
				// eslint-disable-next-line no-await-in-loop -- event stream must be consumed sequentially
				const event = await nextStreamEvent(stream, signal, () => abortSession(oc, sessionId));
				if (event.type === "aborted") return { type: "cancelled" };
				if (event.type === "done") return { type: "idle", tokens: sumTokens(tokensByMessage) };
				const result = classifyEvent(event.value as Event, sessionId, tokensByMessage);
				if (result) return result;
			}
		} finally {
			await returnStreamOnce(stream);
		}
		return { type: "idle" };
	}
	async summarizeSession(sessionId: string, providerId: string, modelId: string): Promise<string> {
		const oc = await this.getClient();
		const result = await oc.session.prompt({
			sessionID: sessionId,
			parts: [{ type: "text", text: SESSION_SUMMARY_PROMPT }],
			model: { providerID: providerId, modelID: modelId },
			tools: {},
		});
		if (result.error || !result.data) {
			throw new Error(`Session summarization failed: ${JSON.stringify(result.error)}`);
		}
		return extractText(result.data.parts);
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
		this.logger?.info(`[opencode] initializing client (port=${this.config.port})`);
		const result = await (this.config.clientFactory ?? createOpencode)({
			port: this.config.port,
			config: {
				mcp: this.config.mcpServers,
				tools: this.config.builtinTools,
				agent:
					this.config.temperature === null || this.config.temperature === undefined
						? undefined
						: { build: { temperature: this.config.temperature } },
			},
		});
		this.client = result.client;
		this.closeServer = result.server.close;
		this.logger?.info(`[opencode] client initialized (port=${this.config.port})`);
		return this.client;
	}
}
