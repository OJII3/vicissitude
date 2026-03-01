import { createOpencode, type OpencodeClient } from "@opencode-ai/sdk/v2";

import type { AgentResponse } from "../../domain/entities/agent-response.ts";
import type { AiAgent, SendOptions } from "../../domain/ports/ai-agent.port.ts";
import type { ContextLoaderFactory } from "../../domain/ports/context-loader.port.ts";
import type { Logger } from "../../domain/ports/logger.port.ts";
import type { SessionRepository } from "../../domain/ports/session-repository.port.ts";
import { withTimeout } from "../../domain/services/timeout.ts";
import { mcpServerConfigs } from "./mcp-config.ts";
import { SessionEventLoop } from "./session-event-loop.ts";

const AGENT_NAME = "opencode";
const SEND_TIMEOUT_MS = 120_000;

export class OpencodeAgent implements AiAgent {
	private client: OpencodeClient | null = null;
	private closeServer: (() => void) | null = null;
	private eventLoop: SessionEventLoop | null = null;

	constructor(
		private readonly sessions: SessionRepository,
		private readonly contextLoaderFactory: ContextLoaderFactory,
		private readonly logger: Logger,
	) {}

	async send(options: SendOptions): Promise<AgentResponse> {
		const { sessionKey, message, guildId } = options;
		const oc = await this.getClient();
		const realId = await this.resolveSessionId(oc, sessionKey);

		const contextLoader = this.contextLoaderFactory.create(guildId);
		const system = await contextLoader.loadBootstrapContext();

		if (!this.eventLoop) {
			throw new Error("eventLoop not initialized");
		}
		const eventLoop = this.eventLoop;

		// question 待ち中なら feedEvent で注入
		if (eventLoop.isWaiting(sessionKey)) {
			eventLoop.feedEvent(sessionKey, message);
			// 既存 LoopState を保持したまま次の応答 Promise を差し替える
			const textPromise = eventLoop.awaitNextResponse(sessionKey);
			const text = await withTimeout(textPromise, SEND_TIMEOUT_MS, "opencode event loop timed out");
			return { text, sessionId: realId };
		}

		// 新規ターン: promptAsync + SSE で応答を収集
		const textPromise = eventLoop.startPrompt(sessionKey, realId);

		const result = await oc.session.promptAsync({
			sessionID: realId,
			parts: [{ type: "text", text: message }],
			model: {
				providerID: process.env.OPENCODE_PROVIDER_ID ?? "opencode",
				modelID: process.env.OPENCODE_MODEL_ID ?? "big-pickle",
			},
			system,
		});

		if (result.error) {
			throw new Error(`opencode promptAsync failed: ${JSON.stringify(result.error)}`);
		}

		const text = await withTimeout(textPromise, SEND_TIMEOUT_MS, "opencode prompt timed out");

		return { text, sessionId: realId };
	}

	stop(): void {
		this.eventLoop?.stop();
		this.closeServer?.();
		this.client = null;
		this.closeServer = null;
		this.eventLoop = null;
	}

	private async resolveSessionId(oc: OpencodeClient, sessionKey: string): Promise<string> {
		let realId = this.sessions.get(AGENT_NAME, sessionKey);

		if (realId) {
			const result = await oc.session.get({ sessionID: realId });
			if (result.error || !result.data) {
				realId = undefined;
			}
		}

		if (!realId) {
			const created = await oc.session.create({ title: `ふあ:${sessionKey}` });
			if (created.error || !created.data) {
				throw new Error(
					`Failed to create session: ${created.error ? JSON.stringify(created.error) : "no data returned"}`,
				);
			}
			realId = created.data.id;
			await this.sessions.save(AGENT_NAME, sessionKey, realId);
		}

		return realId;
	}

	private async getClient(): Promise<OpencodeClient> {
		if (this.client) return this.client;

		const result = await createOpencode({
			config: {
				mcp: mcpServerConfigs(),
				permission: { question: "allow" },
				tools: {
					read: false,
					glob: false,
					grep: false,
					edit: false,
					write: false,
					bash: false,
					webfetch: false,
					task: false,
					todowrite: false,
					skill: false,
				},
			},
		});

		this.client = result.client;
		this.closeServer = result.server.close;

		// SSE イベントストリームを開始
		this.eventLoop = new SessionEventLoop(this.client, this.logger);
		this.eventLoop.startEventStream();

		return this.client;
	}
}
