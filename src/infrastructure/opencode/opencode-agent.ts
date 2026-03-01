import { createOpencode, type OpencodeClient } from "@opencode-ai/sdk";

import type { AgentResponse } from "../../domain/entities/agent-response.ts";
import type { AiAgent, SendOptions } from "../../domain/ports/ai-agent.port.ts";
import type { ContextLoaderFactory } from "../../domain/ports/context-loader.port.ts";
import type { SessionRepository } from "../../domain/ports/session-repository.port.ts";
import { mcpServerConfigs } from "./mcp-config.ts";

const AGENT_NAME = "opencode";

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

		let realId = this.sessions.get(AGENT_NAME, sessionKey);
		let isNew = !realId;

		if (realId) {
			try {
				await oc.session.get({ path: { id: realId } });
			} catch {
				realId = undefined;
				isNew = true;
			}
		}

		if (!realId) {
			const created = await oc.session.create({
				body: { title: `ふあ:${sessionKey}` },
			});
			if (!created.data) throw new Error("Failed to create session: no data returned");
			realId = created.data.id;
			await this.sessions.save(AGENT_NAME, sessionKey, realId);
		}

		const contextLoader = this.contextLoaderFactory.create(guildId);
		const prompt = isNew ? await contextLoader.wrapWithContext(message) : message;

		const result = await oc.session.prompt({
			path: { id: realId },
			body: {
				parts: [{ type: "text", text: prompt }],
				model: { providerID: "github-copilot", modelID: "claude-sonnet-4.6" },
			},
		});

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

	private async getClient(): Promise<OpencodeClient> {
		if (this.client) return this.client;

		const result = await createOpencode({
			config: {
				mcp: mcpServerConfigs(),
			},
		});

		this.client = result.client;
		this.closeServer = result.server.close;
		return this.client;
	}
}
