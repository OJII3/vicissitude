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

/**
 * MCP リクエストタイムアウトの上書き値（3日）。
 * デフォルト 60 秒だと wait_for_events（60秒ブロック）とレースし、
 * MCP 側が先にタイムアウトして無限ループに陥るため十分大きい値を設定する。
 */
const MCP_REQUEST_TIMEOUT_MS = 3 * 24 * 60 * 60 * 1000;

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

	/**
	 * promptAsync でプロンプトを送信し、イベントストリームを監視する。
	 *
	 * 注意: ポーリングモードでは LLM が wait_for_events ツールを繰り返し呼ぶため、
	 * セッションは半永続的に active であり続け、session.idle は通常発火しない。
	 * そのため、この関数はポーリングモードでは事実上返らない。
	 * セッションの異常検知は AgentRunner 側の hang detection timer が担う。
	 */
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

			let unclassifiedCount = 0;
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
				if (event.type === "streamTimeout") {
					this.logger?.warn(`[opencode] SSE stream disconnected: ${event.reason ?? "unknown"}`);
					return { type: "streamDisconnected" };
				}
				const typed = event.value as Event;
				const rawType = (event.value as { type: string }).type;

				const props = "properties" in typed ? (typed.properties as Record<string, unknown>) : {};
				const eventSessionId = props?.sessionID as string | undefined;
				if (rawType !== "server.heartbeat") {
					const msg = `[opencode] stream event: type=${rawType} eventSession=${eventSessionId ?? "?"} targetSession=${params.sessionId}`;
					if (rawType === "session.status" || rawType === "session.updated") {
						this.logger?.info(`${msg} props=${JSON.stringify(props)}`);
					} else {
						this.logger?.debug(msg);
					}
				}

				const classified = classifyEvent(typed, params.sessionId, tokensByMessage);
				if (classified) {
					this.logger?.info(`[opencode] session event: ${classified.type}`);
					return classified;
				}
				unclassifiedCount++;
				if (unclassifiedCount % 50 === 0) {
					this.logger?.info(
						`[opencode] ${unclassifiedCount} unclassified events so far (last: type=${typed.type} session=${eventSessionId ?? "?"})`,
					);
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
		let unclassifiedCount = 0;
		try {
			while (true) {
				// eslint-disable-next-line no-await-in-loop -- event stream must be consumed sequentially
				const event = await nextStreamEvent(stream, signal, () => abortSession(oc, sessionId));
				if (event.type === "aborted") return { type: "cancelled" };
				if (event.type === "done") return { type: "idle", tokens: sumTokens(tokensByMessage) };
				if (event.type === "streamTimeout") {
					this.logger?.warn(
						`[opencode] waitIdle: SSE stream disconnected: ${event.reason ?? "unknown"}`,
					);
					return { type: "streamDisconnected" };
				}
				const typed = event.value as Event;
				const rawType = (event.value as { type: string }).type;
				const props = "properties" in typed ? (typed.properties as Record<string, unknown>) : {};
				const eventSessionId = props?.sessionID as string | undefined;
				if (rawType !== "server.heartbeat") {
					this.logger?.debug(
						`[opencode] waitIdle stream event: type=${rawType} eventSession=${eventSessionId ?? "?"} targetSession=${sessionId}`,
					);
				}
				if (rawType === "session.status" || rawType === "session.updated") {
					this.logger?.info(`[opencode] waitIdle: type=${rawType} props=${JSON.stringify(props)}`);
				}
				const result = classifyEvent(typed, sessionId, tokensByMessage);
				if (result) return result;
				unclassifiedCount++;
				if (unclassifiedCount % 50 === 0) {
					this.logger?.info(
						`[opencode] waitIdle: ${unclassifiedCount} unclassified events (last: type=${rawType} session=${eventSessionId ?? "?"})`,
					);
				}
			}
		} finally {
			await returnStreamOnce(stream);
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
				experimental: {
					mcp_timeout: MCP_REQUEST_TIMEOUT_MS,
				},
			},
		});
		this.client = result.client;
		this.closeServer = result.server.close;
		this.logger?.info(`[opencode] client initialized (port=${this.config.port})`);
		return this.client;
	}
}
