import {
	createOpencode,
	type Event,
	type EventMessageUpdated,
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
	clientFactory?: typeof createOpencode;
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

	async promptAsyncAndWatchSession(
		params: OpencodePromptParams,
		signal?: AbortSignal,
	): Promise<OpencodeSessionEvent> {
		const oc = await this.getClient();
		const { stream } = await oc.event.subscribe();
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

			while (true) {
				// eslint-disable-next-line no-await-in-loop -- event stream must be consumed sequentially
				const event = await nextStreamEvent(stream, signal, () =>
					abortSession(oc, params.sessionId),
				);
				if (event.type === "aborted") return { type: "cancelled" };
				if (event.type === "done") return { type: "idle", tokens: sumTokens(tokensByMessage) };
				const classified = classifyEvent(event.value as Event, params.sessionId, tokensByMessage);
				if (classified) return classified;
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
		const result = await (this.config.clientFactory ?? createOpencode)({
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
type AbortableAsyncStream<T> = AsyncIterator<T> & {
	return?: (value?: unknown) => Promise<IteratorResult<T>>;
};
const STREAM_RETURNED = Symbol("streamReturned"),
	STREAM_RETURN_PROMISE = Symbol("streamReturnPromise");
type StreamReadResult = { type: "event"; value: unknown } | { type: "done" } | { type: "aborted" };

async function nextStreamEvent(
	stream: AbortableAsyncStream<unknown>,
	signal: AbortSignal | undefined,
	onAbort: () => Promise<void>,
): Promise<StreamReadResult> {
	if (!signal) {
		const result = await stream.next();
		return result.done ? { type: "done" } : { type: "event", value: result.value };
	}
	return waitForNextStreamEvent(stream, signal, onAbort);
}
function waitForNextStreamEvent(
	stream: AbortableAsyncStream<unknown>,
	signal: AbortSignal,
	onAbort: () => Promise<void>,
): Promise<StreamReadResult> {
	return new Promise<StreamReadResult>((resolve, reject) => {
		let settled = false;
		const finish = (complete: () => void) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", handleAbort);
			complete();
		};
		const handleAbort = () => {
			finish(() => {
				void onAbort();
				void returnStreamOnce(stream).catch(() => {});
				resolve({ type: "aborted" });
			});
		};
		signal.addEventListener("abort", handleAbort, { once: true });
		if (signal.aborted) {
			handleAbort();
			return;
		}
		void (async () => {
			try {
				const result = await stream.next();
				finish(() =>
					resolve(result.done ? { type: "done" } : { type: "event", value: result.value }),
				);
			} catch (error) {
				finish(() => reject(error));
			}
		})();
	});
}
function returnStreamOnce(stream: AbortableAsyncStream<unknown>): Promise<void> {
	const managed = stream as AbortableAsyncStream<unknown> & {
		[STREAM_RETURNED]?: boolean;
		[STREAM_RETURN_PROMISE]?: Promise<unknown>;
	};
	if (managed[STREAM_RETURN_PROMISE]) return managed[STREAM_RETURN_PROMISE] as Promise<void>;
	if (managed[STREAM_RETURNED]) return Promise.resolve();
	managed[STREAM_RETURNED] = true;
	managed[STREAM_RETURN_PROMISE] = managed.return ? managed.return() : Promise.resolve();
	return managed[STREAM_RETURN_PROMISE] as Promise<void>;
}
async function abortSession(oc: OpencodeClient, sessionId: string): Promise<void> {
	try {
		const result = await oc.session.abort({ sessionID: sessionId });
		if (result.error) {
		}
	} catch {
		// 停止経路ではベストエフォート。unhandled rejection にはしない。
	}
}
function classifyEvent(
	typed: Event,
	sessionId: string,
	tokensByMessage: Map<string, TokenUsage>,
): OpencodeSessionEvent | null {
	if (typed.type === "message.updated") {
		accumulateTokens(typed as EventMessageUpdated, sessionId, tokensByMessage);
		return null;
	}
	if (typed.type === "session.idle") {
		const idle = typed as EventSessionIdle;
		if (idle.properties.sessionID === sessionId) {
			return { type: "idle", tokens: sumTokens(tokensByMessage) };
		}
	}
	if (typed.type === "session.compacted") {
		const compacted = typed as EventSessionCompacted;
		if (compacted.properties.sessionID === sessionId) return { type: "compacted" };
	}
	if (typed.type === "session.error") {
		const err = typed as EventSessionError;
		if (err.properties.sessionID === sessionId) {
			return { type: "error", message: JSON.stringify(err.properties) };
		}
	}
	return null;
}
function accumulateTokens(
	typed: EventMessageUpdated,
	sessionId: string,
	tokensByMessage: Map<string, TokenUsage>,
): void {
	const info = typed.properties.info;
	if (info.role === "assistant" && info.sessionID === sessionId) {
		tokensByMessage.set(info.id, {
			input: info.tokens.input,
			output: info.tokens.output,
			cacheRead: info.tokens.cache?.read ?? 0,
		});
	}
}
function extractText(parts: Part[]): string {
	return parts
		.filter((p): p is Part & { type: "text" } => p.type === "text")
		.map((p) => p.text)
		.join("");
}
function extractTokens(info: {
	tokens?: { input: number; output: number; cache?: { read: number } };
}): TokenUsage | undefined {
	if (!info.tokens) return undefined;
	return {
		input: info.tokens.input,
		output: info.tokens.output,
		cacheRead: info.tokens.cache?.read ?? 0,
	};
}
function sumTokens(tokensByMessage: Map<string, TokenUsage>): TokenUsage | undefined {
	if (tokensByMessage.size === 0) return undefined;
	let cacheRead = 0;
	let input = 0;
	let output = 0;
	for (const t of tokensByMessage.values()) {
		input += t.input;
		output += t.output;
		cacheRead += t.cacheRead;
	}
	return { input, output, cacheRead };
}
