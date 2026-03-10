import {
	createOpencode,
	type Event,
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
} from "../core/types.ts";

export interface OpencodeSessionAdapterConfig {
	port: number;
	mcpServers: Record<string, McpLocalConfig | McpRemoteConfig | { enabled: boolean }>;
	builtinTools: Record<string, boolean>;
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

	async prompt(params: OpencodePromptParams): Promise<string> {
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
		return extractText(result.data.parts);
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

	async waitForSessionIdle(sessionId: string, signal?: AbortSignal): Promise<OpencodeSessionEvent> {
		const oc = await this.getClient();
		const { stream } = await oc.event.subscribe();

		try {
			for await (const event of stream) {
				if (signal?.aborted) return { type: "idle" };

				const typed = event as Event;
				if (typed.type === "session.idle") {
					const idle = typed as EventSessionIdle;
					if (idle.properties.sessionID === sessionId) {
						return { type: "idle" };
					}
				}
				if (typed.type === "session.compacted") {
					const compacted = typed as EventSessionCompacted;
					if (compacted.properties.sessionID === sessionId) {
						return { type: "compacted" };
					}
				}
				if (typed.type === "session.error") {
					const err = typed as EventSessionError;
					if (err.properties.sessionID === sessionId) {
						return { type: "error", message: JSON.stringify(err.properties) };
					}
				}
			}
		} finally {
			// oxlint-disable-next-line no-useless-undefined -- AsyncIterator.return requires an argument
			await stream.return?.(undefined);
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

		const result = await createOpencode({
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

function extractText(parts: Part[]): string {
	return parts
		.filter((p): p is Part & { type: "text" } => p.type === "text")
		.map((p) => p.text)
		.join("");
}
