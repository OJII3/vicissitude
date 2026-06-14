import { mkdirSync } from "fs";

import {
	createOpencode,
	type AgentConfig,
	type Config as OpencodeConfig,
	type McpLocalConfig,
	type McpRemoteConfig,
	type OpencodeClient,
} from "@opencode-ai/sdk/v2";
import {
	HttpImageFetcher,
	type ImageFetcher,
} from "@vicissitude/infrastructure/http/image-fetcher";
import type {
	Logger,
	OpencodeSessionActivity,
	OpencodePromptParams,
	OpencodeSessionEvent,
	OpencodeModel,
	OpencodeSessionPort,
	PromptResult,
	SkillPermissionConfig,
	TokenUsage,
} from "@vicissitude/shared/types";

import { consumeSessionEventStream } from "./session-event-stream.ts";
import { abortSession, extractText, extractTokens, returnStreamOnce } from "./stream-helpers.ts";

/** OpenCode Go バイナリが MCP ツール呼び出しに適用するタイムアウト（1時間） */
const MCP_REQUEST_TIMEOUT_MS = 60 * 60 * 1000;

export interface OpencodeSessionAdapterConfig {
	port: number;
	/** `{ enabled: boolean }` は SDK の設定スキーマが許容する無効化用のフォールバック型 */
	mcpServers: Record<string, McpLocalConfig | McpRemoteConfig | { enabled: boolean }>;
	builtinTools: Record<string, boolean>;
	skillPermission: SkillPermissionConfig;
	skillPaths?: string[];
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
	imageFetcher?: ImageFetcher;
}

export type OpencodeAgentConfig = AgentConfig;

type OpencodePromptPart =
	| { type: "text"; text: string }
	| { type: "file"; mime: string; filename?: string; url: string };

export class OpencodeSessionAdapter implements OpencodeSessionPort {
	private client: OpencodeClient | null = null;
	private closeServer: (() => void) | null = null;
	private readonly logger?: Logger;
	private readonly imageFetcher: ImageFetcher;
	constructor(private readonly config: OpencodeSessionAdapterConfig) {
		this.logger = config.logger;
		this.imageFetcher = config.imageFetcher ?? new HttpImageFetcher({ logger: config.logger });
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

	private async buildParts(params: OpencodePromptParams): Promise<OpencodePromptPart[]> {
		const imageAttachments = (
			await Promise.all(
				(params.attachments ?? []).map(async (attachment): Promise<OpencodePromptPart | null> => {
					if (!attachment.contentType?.startsWith("image/")) {
						this.logger?.debug(
							`[opencode] buildParts: skipping non-image attachment (contentType=${attachment.contentType ?? "undefined"}, filename=${attachment.filename ?? "undefined"})`,
						);
						return null;
					}
					const fetched = await this.imageFetcher.fetch(attachment.url);
					if (!fetched) {
						this.logger?.warn(
							`[opencode] buildParts: failed to normalize image attachment (filename=${attachment.filename ?? "undefined"}, url=${attachment.url})`,
						);
						return null;
					}
					return {
						type: "file" as const,
						mime: fetched.mimeType,
						filename: attachment.filename,
						url: `data:${fetched.mimeType};base64,${fetched.base64}`,
					};
				}),
			)
		).filter((part): part is Extract<OpencodePromptPart, { type: "file" }> => part !== null);
		return [{ type: "text", text: params.text }, ...imageAttachments];
	}

	private async sendPromptAsync(
		oc: OpencodeClient,
		params: OpencodePromptParams,
		parts: OpencodePromptPart[],
	): Promise<void> {
		const result = await oc.session.promptAsync({
			sessionID: params.sessionId,
			...this.directoryQuery(),
			parts,
			model: { providerID: params.model.providerId, modelID: params.model.modelId },
			system: params.system,
		});
		if (result.error) {
			throw new Error(`promptAsync failed: ${JSON.stringify(result.error)}`);
		}
	}

	async prompt(params: OpencodePromptParams, signal?: AbortSignal): Promise<PromptResult> {
		const modelLabel = `${params.model.providerId}/${params.model.modelId}`;
		this.logger?.debug("[opencode] llm_request", {
			model: modelLabel,
			prompt: params.text,
			system: params.system,
		});
		const oc = await this.getClient();
		const parts = await this.buildParts(params);
		const result = await oc.session.prompt(
			{
				sessionID: params.sessionId,
				...this.directoryQuery(),
				parts,
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
		const parts = await this.buildParts(params);
		await this.sendPromptAsync(oc, params, parts);
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
		const parts = await this.buildParts(params);
		const { stream } = await oc.event.subscribe(this.directoryQuery());
		this.logger?.info("[opencode] event stream subscribed");
		const tokensByMessage = new Map<string, TokenUsage>();
		try {
			await this.sendPromptAsync(oc, params, parts);
			this.logger?.info("[opencode] promptAsync sent, watching events...");
			return await consumeSessionEventStream({
				stream,
				signal,
				sessionId: params.sessionId,
				onAbort: () => abortSession(oc, params.sessionId, this.config.directory),
				tokensByMessage,
				onActivity: params.onActivity,
				logger: this.logger,
				log: { prefix: "", logClassifiedSuccess: true },
			});
		} finally {
			await returnStreamOnce(stream);
		}
	}
	async waitForSessionIdle(
		sessionId: string,
		signal?: AbortSignal,
		onActivity?: (activity: OpencodeSessionActivity) => void,
	): Promise<OpencodeSessionEvent> {
		const oc = await this.getClient();
		const { stream } = await oc.event.subscribe(this.directoryQuery());
		const tokensByMessage = new Map<string, TokenUsage>();
		try {
			return await consumeSessionEventStream({
				stream,
				signal,
				sessionId,
				onAbort: () => abortSession(oc, sessionId, this.config.directory),
				tokensByMessage,
				onActivity,
				logger: this.logger,
				log: { prefix: "waitIdle: ", logClassifiedSuccess: false },
			});
		} finally {
			await returnStreamOnce(stream);
		}
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
		const result = await oc.session.delete({ sessionID: sessionId, ...this.directoryQuery() });
		if (result.error) {
			throw new Error(`deleteSession failed: ${JSON.stringify(result.error)}`);
		}
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
					skills: this.config.skillPaths ? { paths: this.config.skillPaths } : undefined,
					permission: {
						skill: this.config.skillPermission,
					},
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
