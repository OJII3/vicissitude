/* oxlint-disable max-lines -- OpenCode SDK adapter keeps session operations and stream handling in one cohesive boundary */
import { mkdirSync } from "fs";

import {
	createOpencode,
	type AgentConfig,
	type Config as OpencodeConfig,
	type Event,
	type McpLocalConfig,
	type McpRemoteConfig,
	type OpencodeClient,
} from "@opencode-ai/sdk/v2";
import type {
	Logger,
	OpencodePromptParams,
	OpencodeSessionEvent,
	OpencodeModel,
	OpencodeSessionPort,
	PromptResult,
	TokenUsage,
} from "@vicissitude/shared/types";

import {
	abortSession,
	classifyEvent,
	extractText,
	extractTokens,
	logPartActivity,
	nextStreamEvent,
	returnStreamOnce,
	sumTokens,
} from "./stream-helpers.ts";

/** OpenCode Go バイナリが MCP ツール呼び出しに適用するタイムアウト（1時間） */
const MCP_REQUEST_TIMEOUT_MS = 60 * 60 * 1000;

export interface OpencodeSessionAdapterConfig {
	port: number;
	/** `{ enabled: boolean }` は SDK の設定スキーマが許容する無効化用のフォールバック型 */
	mcpServers: Record<string, McpLocalConfig | McpRemoteConfig | { enabled: boolean }>;
	builtinTools: Record<string, boolean>;
	agents?: Record<string, AgentConfig>;
	defaultAgent?: string;
	primaryTools?: string[];
	temperature?: number;
	/** OpenCode の session / tool 実行に使う project directory */
	directory?: string;
	/** OpenCode server process に追加で渡す環境変数 */
	environment?: Record<string, string>;
	clientFactory?: typeof createOpencode;
	logger?: Logger;
}

export type OpencodeAgentConfig = AgentConfig;

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
		const result = await oc.session.create({ title, ...this.directoryQuery() });
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
		const result = await oc.session.get({ sessionID: sessionId, ...this.directoryQuery() });
		return !result.error && !!result.data;
	}

	private buildParts(
		params: OpencodePromptParams,
	): Array<
		{ type: "text"; text: string } | { type: "file"; mime: string; filename?: string; url: string }
	> {
		const imageAttachments: Array<{ type: "file"; mime: string; filename?: string; url: string }> =
			[];
		for (const a of params.attachments ?? []) {
			if (a.contentType?.startsWith("image/")) {
				imageAttachments.push({
					type: "file" as const,
					mime: a.contentType,
					filename: a.filename,
					url: a.url,
				});
			} else {
				this.logger?.debug(
					`[opencode] buildParts: skipping non-image attachment (contentType=${a.contentType ?? "undefined"}, filename=${a.filename ?? "undefined"})`,
				);
			}
		}
		return [{ type: "text", text: params.text }, ...imageAttachments];
	}

	async prompt(params: OpencodePromptParams, signal?: AbortSignal): Promise<PromptResult> {
		const modelLabel = `${params.model.providerId}/${params.model.modelId}`;
		this.logger?.debug("[opencode] llm_request", {
			model: modelLabel,
			prompt: params.text,
			system: params.system,
		});
		const oc = await this.getClient();
		const result = await oc.session.prompt(
			{
				sessionID: params.sessionId,
				...this.directoryQuery(),
				parts: this.buildParts(params),
				model: { providerID: params.model.providerId, modelID: params.model.modelId },
				system: params.system,
				tools: params.tools ?? {},
			},
			{ signal },
		);
		if (result.error || !result.data) {
			throw new Error(`Prompt failed: ${JSON.stringify(result.error)}`);
		}
		const text = extractText(result.data.parts);
		const tokens = extractTokens(result.data.info);
		this.logger?.debug("[opencode] llm_response", {
			model: modelLabel,
			text,
			tokens,
		});
		return { text, tokens };
	}

	async promptAsync(params: OpencodePromptParams): Promise<void> {
		const oc = await this.getClient();
		const result = await oc.session.promptAsync({
			sessionID: params.sessionId,
			...this.directoryQuery(),
			parts: this.buildParts(params),
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
	 * LLM がプロンプトの処理を完了すると session.idle イベントが発火し、この関数が返る。
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
				...this.directoryQuery(),
				parts: this.buildParts(params),
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
					abortSession(oc, params.sessionId, this.config.directory),
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
					return { type: "streamDisconnected", tokens: sumTokens(tokensByMessage) };
				}
				if (event.type === "streamError") {
					this.logger?.error(`[opencode] SSE stream error: ${event.reason}`);
					return { type: "streamDisconnected", tokens: sumTokens(tokensByMessage) };
				}
				const typed = event.value as Event;
				const rawType = (event.value as { type: string }).type;

				const props = "properties" in typed ? (typed.properties as Record<string, unknown>) : {};
				const eventSessionId = props?.sessionID as string | undefined;
				const msg = `[opencode] stream event: type=${rawType} eventSession=${eventSessionId ?? "?"} targetSession=${params.sessionId}`;
				if (rawType === "session.status" || rawType === "session.updated") {
					this.logger?.info(`${msg} props=${JSON.stringify(props)}`);
				} else {
					this.logger?.debug(msg);
				}

				logPartActivity(typed, params.sessionId, this.logger);

				const classified = classifyEvent(typed, params.sessionId, tokensByMessage);
				if (classified) {
					if (classified.type === "error") {
						this.logger?.error(
							`[opencode] session.error event: ${classified.message ?? "unknown"}`,
						);
					} else {
						this.logger?.info(`[opencode] session event: ${classified.type}`);
					}
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
				const event = await nextStreamEvent(stream, signal, () =>
					abortSession(oc, sessionId, this.config.directory),
				);
				if (event.type === "aborted") return { type: "cancelled" };
				if (event.type === "done") return { type: "idle", tokens: sumTokens(tokensByMessage) };
				if (event.type === "streamTimeout") {
					this.logger?.warn(
						`[opencode] waitIdle: SSE stream disconnected: ${event.reason ?? "unknown"}`,
					);
					return { type: "streamDisconnected", tokens: sumTokens(tokensByMessage) };
				}
				if (event.type === "streamError") {
					this.logger?.error(`[opencode] waitIdle: SSE stream error: ${event.reason}`);
					return { type: "streamDisconnected", tokens: sumTokens(tokensByMessage) };
				}
				const typed = event.value as Event;
				const rawType = (event.value as { type: string }).type;
				const props = "properties" in typed ? (typed.properties as Record<string, unknown>) : {};
				const eventSessionId = props?.sessionID as string | undefined;
				this.logger?.debug(
					`[opencode] waitIdle stream event: type=${rawType} eventSession=${eventSessionId ?? "?"} targetSession=${sessionId}`,
				);
				if (rawType === "session.status" || rawType === "session.updated") {
					this.logger?.info(`[opencode] waitIdle: type=${rawType} props=${JSON.stringify(props)}`);
				}
				logPartActivity(typed, sessionId, this.logger);
				const result = classifyEvent(typed, sessionId, tokensByMessage);
				if (result) {
					if (result.type === "error") {
						this.logger?.error(
							`[opencode] waitIdle: session.error event: ${result.message ?? "unknown"}`,
						);
					}
					return result;
				}
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
	async summarizeSession(sessionId: string, model: OpencodeModel): Promise<void> {
		this.logger?.info(`[opencode] summarizing session: ${sessionId}`);
		const oc = await this.getClient();
		const result = await oc.session.summarize({
			sessionID: sessionId,
			...this.directoryQuery(),
			providerID: model.providerId,
			modelID: model.modelId,
		});
		if (result.error) {
			throw new Error(`summarizeSession failed: ${JSON.stringify(result.error)}`);
		}
		this.logger?.info(`[opencode] summarize requested for session: ${sessionId}`);
	}

	async deleteSession(sessionId: string): Promise<void> {
		const oc = await this.getClient();
		await oc.session.delete({ sessionID: sessionId, ...this.directoryQuery() });
	}

	close(): void {
		this.closeServer?.();
		this.client = null;
		this.closeServer = null;
	}

	private buildAgentConfig(): OpencodeConfig["agent"] {
		const agent = this.config.agents ? { ...this.config.agents } : {};
		if (this.config.temperature !== null && this.config.temperature !== undefined) {
			agent.build = {
				...agent.build,
				temperature: this.config.temperature,
			};
		}
		return Object.keys(agent).length > 0 ? agent : undefined;
	}

	private directoryQuery(): { directory?: string } {
		return this.config.directory ? { directory: this.config.directory } : {};
	}

	private async getClient(): Promise<OpencodeClient> {
		if (this.client) return this.client;
		this.logger?.info(`[opencode] initializing client (port=${this.config.port})`);
		if (this.config.directory) {
			mkdirSync(this.config.directory, { recursive: true });
		}
		const agent = this.buildAgentConfig();
		const result = await withProcessEnvironment(this.config.environment, () =>
			(this.config.clientFactory ?? createOpencode)({
				port: this.config.port,
				config: {
					mcp: this.config.mcpServers,
					tools: this.config.builtinTools,
					default_agent: this.config.defaultAgent,
					agent,
					experimental: {
						mcp_timeout: MCP_REQUEST_TIMEOUT_MS,
						primary_tools: this.config.primaryTools,
					},
				},
			}),
		);
		this.client = result.client;
		this.closeServer = result.server.close.bind(result.server);
		this.logger?.info(`[opencode] client initialized (port=${this.config.port})`);
		return this.client;
	}
}

function withProcessEnvironment<T>(
	environment: Record<string, string> | undefined,
	run: () => T,
): T {
	if (!environment || Object.keys(environment).length === 0) return run();
	const previous = new Map<string, string | undefined>();
	for (const [name, value] of Object.entries(environment)) {
		const previousValue = process.env[name] as string | undefined;
		previous.set(name, previousValue);
		process.env[name] = value;
	}
	try {
		return run();
	} finally {
		for (const [name, value] of previous) {
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		}
	}
}
