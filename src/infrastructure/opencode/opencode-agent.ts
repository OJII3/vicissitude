import { createOpencode, type OpencodeClient } from "@opencode-ai/sdk/v2";

import type { AgentResponse } from "../../domain/entities/agent-response.ts";
import type { AiAgent, SendOptions } from "../../domain/ports/ai-agent.port.ts";
import type { ContextLoaderFactory } from "../../domain/ports/context-loader.port.ts";
import type { Logger } from "../../domain/ports/logger.port.ts";
import type { SessionRepository } from "../../domain/ports/session-repository.port.ts";
import { mcpServerConfigs } from "./mcp-config.ts";

const AGENT_NAME = "opencode";

export class OpencodeAgent implements AiAgent {
	private client: OpencodeClient | null = null;
	private closeServer: (() => void) | null = null;

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

		const result = await oc.session.prompt({
			sessionID: realId,
			parts: [{ type: "text", text: message }],
			model: {
				providerID: process.env.OPENCODE_PROVIDER_ID ?? "opencode",
				modelID: process.env.OPENCODE_MODEL_ID ?? "big-pickle",
			},
			system,
		});

		if (result.error) {
			throw new Error(`opencode prompt failed: ${JSON.stringify(result.error)}`);
		}

		const texts: string[] = [];
		if (result.data?.parts) {
			for (const part of result.data.parts) {
				if (part.type === "text") {
					texts.push(part.text);
				}
			}
		}

		return { text: texts.join("\n") || "", sessionId: realId };
	}

	stop(): void {
		this.closeServer?.();
		this.client = null;
		this.closeServer = null;
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
}
