import { createOpencode, type OpencodeClient } from "@opencode-ai/sdk";

import type { AgentResponse } from "../../domain/entities/agent-response.ts";
import type { AiAgent, SendOptions } from "../../domain/ports/ai-agent.port.ts";
import type { ContextLoaderFactory } from "../../domain/ports/context-loader.port.ts";
import type { SessionRepository } from "../../domain/ports/session-repository.port.ts";
import { withTimeout } from "../../domain/services/timeout.ts";
import { mcpServerConfigs } from "./mcp-config.ts";

const AGENT_NAME = "opencode";
const SEND_TIMEOUT_MS = 120_000;

export class OpencodeAgent implements AiAgent {
	private client: OpencodeClient | null = null;
	private closeServer: (() => void) | null = null;

	constructor(
		private readonly sessions: SessionRepository,
		private readonly contextLoaderFactory: ContextLoaderFactory,
	) {}

	async send(options: SendOptions): Promise<AgentResponse> {
		const { sessionKey, message, guildId } = options;
		const oc = await this.getClient();
		const realId = await this.resolveSessionId(oc, sessionKey);

		const contextLoader = this.contextLoaderFactory.create(guildId);
		const system = await contextLoader.loadBootstrapContext();

		const result = await withTimeout(
			oc.session.prompt({
				path: { id: realId },
				body: {
					parts: [{ type: "text", text: message }],
					model: {
						providerID: process.env.OPENCODE_PROVIDER_ID ?? "opencode",
						modelID: process.env.OPENCODE_MODEL_ID ?? "big-pickle",
					},
					system,
				},
			}),
			SEND_TIMEOUT_MS,
			"opencode prompt timed out",
		);

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

		return {
			text: texts.join("\n") || "(no response)",
			sessionId: realId,
		};
	}

	stop(): void {
		this.closeServer?.();
		this.client = null;
		this.closeServer = null;
	}

	private async resolveSessionId(oc: OpencodeClient, sessionKey: string): Promise<string> {
		let realId = this.sessions.get(AGENT_NAME, sessionKey);

		if (realId) {
			const result = await oc.session.get({ path: { id: realId } });
			if (result.error || !result.data) {
				realId = undefined;
			}
		}

		if (!realId) {
			const created = await oc.session.create({
				body: { title: `ふあ:${sessionKey}` },
			});
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
		return this.client;
	}
}
