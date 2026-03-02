import {
	createOpencode,
	type Event,
	type EventSessionError,
	type EventSessionIdle,
	type OpencodeClient,
} from "@opencode-ai/sdk/v2";

import type { AgentResponse } from "../../domain/entities/agent-response.ts";
import type { AiAgent, SendOptions } from "../../domain/ports/ai-agent.port.ts";
import type { ContextLoaderFactory } from "../../domain/ports/context-loader.port.ts";
import type { EventBuffer } from "../../domain/ports/event-buffer.port.ts";
import type { Logger } from "../../domain/ports/logger.port.ts";
import type { SessionRepository } from "../../domain/ports/session-repository.port.ts";
import { mcpServerConfigs } from "./mcp-config.ts";

const AGENT_NAME = "copilot-polling";
const POLLING_SESSION_KEY = "__polling__";
const MAX_RECONNECT_DELAY_MS = 30_000;
const INITIAL_RECONNECT_DELAY_MS = 2_000;

const POLLING_PROMPT = `あなたは Discord bot「ふあ」です。以下のループを実行してください:

1. event_count ツールでイベント数を確認
2. イベントが 0 件なら wait ツールで5秒待機して 1 に戻る
3. イベントがあれば read_events でイベントを取得
4. 各イベントを処理:
   - まず discord の send_typing で channelId にタイピングインジケーターを送信
   - isMentioned=true → discord の send_message で channelId に返信
   - isMentioned=false → 会話の文脈を読み、必要に応じて send_message で返信
5. 処理が終わったら 1 に戻る

重要:
- このループは永久に続けてください。絶対に自発的に停止しないでください。
- wait ツールで待機してください: wait(5)
- エラーが発生しても続行してください
- 各イベントの channelId に対して返信してください
- 返信を作成する前に必ず send_typing を呼んでください（ユーザーに考え中であることを示します）`;

export class CopilotPollingAgent implements AiAgent {
	private client: OpencodeClient | null = null;
	private closeServer: (() => void) | null = null;
	private abortController: AbortController | null = null;
	private running = false;

	constructor(
		private readonly sessions: SessionRepository,
		private readonly contextLoaderFactory: ContextLoaderFactory,
		private readonly eventBuffer: EventBuffer,
		private readonly logger: Logger,
	) {}

	async send(options: SendOptions): Promise<AgentResponse> {
		const { message, guildId } = options;
		await this.eventBuffer.append({
			ts: new Date().toISOString(),
			channelId: "system",
			guildId,
			authorId: "system",
			authorName: "system",
			messageId: `send-${Date.now()}`,
			content: message,
			isMentioned: false,
			isThread: false,
		});
		return { text: "", sessionId: "copilot-polling" };
	}

	async startPollingLoop(): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.abortController = new AbortController();

		let delay = INITIAL_RECONNECT_DELAY_MS;

		while (this.running && !this.abortController.signal.aborted) {
			try {
				// eslint-disable-next-line no-await-in-loop -- sequential restart is intentional
				await this.runPollingSession();
				delay = INITIAL_RECONNECT_DELAY_MS;
			} catch (err) {
				if (this.abortController.signal.aborted) return;
				this.logger.error("[copilot-polling] session error, will restart", err);
			}

			if (this.abortController.signal.aborted) return;

			this.logger.info(`[copilot-polling] restarting in ${delay}ms...`);
			// eslint-disable-next-line no-await-in-loop -- backoff delay between restarts
			await this.sleep(delay);
			delay = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
		}
	}

	stop(): void {
		this.running = false;
		this.abortController?.abort();
		this.abortController = null;
		this.closeServer?.();
		this.client = null;
		this.closeServer = null;
	}

	private async runPollingSession(): Promise<void> {
		const oc = await this.getClient();
		const sessionId = await this.resolveSessionId(oc);

		const contextLoader = this.contextLoaderFactory.create();
		const system = await contextLoader.loadBootstrapContext();

		this.logger.info(`[copilot-polling] starting polling prompt on session ${sessionId}`);

		const result = await oc.session.promptAsync({
			sessionID: sessionId,
			parts: [{ type: "text", text: POLLING_PROMPT }],
			model: {
				providerID: process.env.OPENCODE_PROVIDER_ID ?? "github-copilot",
				modelID: process.env.OPENCODE_MODEL_ID ?? "big-pickle",
			},
			system,
		});

		if (result.error) {
			throw new Error(`promptAsync failed: ${JSON.stringify(result.error)}`);
		}

		// SSE で session.idle / session.error を検知するまで待つ
		await this.monitorSession(oc, sessionId);
	}

	private async monitorSession(oc: OpencodeClient, sessionId: string): Promise<void> {
		const { stream } = await oc.event.subscribe();

		try {
			for await (const event of stream) {
				if (this.abortController?.signal.aborted) return;

				const typed = event as Event;
				if (typed.type === "session.idle") {
					const idle = typed as EventSessionIdle;
					if (idle.properties.sessionID === sessionId) {
						this.logger.info("[copilot-polling] session went idle, will restart");
						return;
					}
				}
				if (typed.type === "session.error") {
					const err = typed as EventSessionError;
					if (err.properties.sessionID === sessionId) {
						this.logger.error("[copilot-polling] session error event", err.properties);
						return;
					}
				}
			}
		} finally {
			// eslint-disable-next-line unicorn/no-useless-undefined -- AsyncIterator.return requires an argument
			await stream.return?.(undefined);
		}
	}

	private async resolveSessionId(oc: OpencodeClient): Promise<string> {
		let realId = this.sessions.get(AGENT_NAME, POLLING_SESSION_KEY);

		if (realId) {
			const result = await oc.session.get({ sessionID: realId });
			if (result.error || !result.data) {
				realId = undefined;
			}
		}

		if (!realId) {
			const created = await oc.session.create({ title: "ふあ:polling" });
			if (created.error || !created.data) {
				throw new Error(
					`Failed to create session: ${created.error ? JSON.stringify(created.error) : "no data returned"}`,
				);
			}
			realId = created.data.id;
			await this.sessions.save(AGENT_NAME, POLLING_SESSION_KEY, realId);
		}

		return realId;
	}

	private async getClient(): Promise<OpencodeClient> {
		if (this.client) return this.client;

		const result = await createOpencode({
			config: {
				mcp: mcpServerConfigs({ includeEventBuffer: true }),
				tools: {
					question: false,
					read: false,
					glob: false,
					grep: false,
					edit: false,
					write: false,
					bash: false,
					webfetch: true,
					websearch: true,
					task: false,
					todowrite: false,
					skill: false,
				},
			},
		});

		this.client = result.client;
		this.closeServer = result.server.close;
		return this.client;
	}

	private sleep(ms: number): Promise<void> {
		if (this.abortController?.signal.aborted) return Promise.resolve();
		return new Promise((resolve) => {
			let resolved = false;
			const done = () => {
				if (resolved) return;
				resolved = true;
				resolve();
			};
			const timer = setTimeout(done, ms);
			this.abortController?.signal.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					done();
				},
				{ once: true },
			);
		});
	}
}
