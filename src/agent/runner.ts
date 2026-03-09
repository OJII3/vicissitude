import {
	createOpencode,
	type Event,
	type EventSessionError,
	type EventSessionIdle,
	type OpencodeClient,
} from "@opencode-ai/sdk/v2";

import type { AgentResponse, BufferedEvent, Logger } from "../core/types.ts";
import type { ContextBuilder } from "./context-builder.ts";
import type { AgentProfile } from "./profile.ts";
import type { AiAgent, SendOptions } from "./router.ts";
import type { SessionStore } from "./session-store.ts";

export interface EventBuffer {
	append(event: BufferedEvent): void | Promise<void>;
	waitForEvents(signal: AbortSignal): Promise<void>;
}

const MAX_RECONNECT_DELAY_MS = 30_000;
const INITIAL_RECONNECT_DELAY_MS = 2_000;

export interface RunnerDeps {
	profile: AgentProfile;
	guildId: string;
	sessionStore: SessionStore;
	contextBuilder: ContextBuilder;
	logger: Logger;
	port: number;
	eventBuffer: EventBuffer;
	sessionMaxAgeMs: number;
}

export class AgentRunner implements AiAgent {
	private client: OpencodeClient | null = null;
	private closeServer: (() => void) | null = null;
	private abortController: AbortController | null = null;
	private running = false;
	private sessionCreatedAt: number | null = null;

	private readonly profile: AgentProfile;
	private readonly guildId: string;
	private readonly sessionStore: SessionStore;
	private readonly contextBuilder: ContextBuilder;
	private readonly logger: Logger;
	private readonly port: number;
	private readonly eventBuffer: EventBuffer;
	private readonly sessionMaxAgeMs: number;

	constructor(deps: RunnerDeps) {
		this.profile = deps.profile;
		this.guildId = deps.guildId;
		this.sessionStore = deps.sessionStore;
		this.contextBuilder = deps.contextBuilder;
		this.logger = deps.logger;
		this.port = deps.port;
		this.eventBuffer = deps.eventBuffer;
		this.sessionMaxAgeMs = deps.sessionMaxAgeMs;
	}

	async send(options: SendOptions): Promise<AgentResponse> {
		const { message, guildId, attachments } = options;
		await this.eventBuffer.append({
			ts: new Date().toISOString(),
			channelId: "system",
			guildId,
			authorId: "system",
			authorName: "system",
			messageId: `send-${Date.now()}`,
			content: message,
			attachments: attachments && attachments.length > 0 ? attachments : undefined,
			isBot: false,
			isMentioned: false,
			isThread: false,
		});
		return { text: "", sessionId: "polling" };
	}

	async startPollingLoop(): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.abortController = new AbortController();

		let delay = INITIAL_RECONNECT_DELAY_MS;

		while (this.running && !this.abortController.signal.aborted) {
			try {
				this.logger.info(`[${this.profile.name}:${this.guildId}] waiting for events...`);
				// oxlint-disable-next-line no-await-in-loop -- must wait for events before starting session
				await this.eventBuffer.waitForEvents(this.abortController.signal);
				if (this.abortController.signal.aborted) return;
				this.logger.info(
					`[${this.profile.name}:${this.guildId}] events detected, starting session`,
				);
				// eslint-disable-next-line no-await-in-loop -- sequential restart is intentional
				await this.runPollingSession();
				// eslint-disable-next-line no-await-in-loop -- session rotation must happen sequentially
				await this.rotateSessionIfExpired();
				delay = INITIAL_RECONNECT_DELAY_MS;
			} catch (err) {
				if (this.abortController.signal.aborted) return;
				this.logger.error(
					`[${this.profile.name}:${this.guildId}] session error, will restart`,
					err,
				);
			}

			if (this.abortController.signal.aborted) return;

			this.logger.info(`[${this.profile.name}:${this.guildId}] restarting in ${delay}ms...`);
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

		const system = await this.contextBuilder.build(this.guildId);

		this.logger.info(
			`[${this.profile.name}:${this.guildId}] starting polling prompt on session ${sessionId}`,
		);

		const result = await oc.session.promptAsync({
			sessionID: sessionId,
			parts: [{ type: "text", text: this.profile.pollingPrompt }],
			model: {
				providerID: this.profile.model.providerId,
				modelID: this.profile.model.modelId,
			},
			system,
		});

		if (result.error) {
			throw new Error(`promptAsync failed: ${JSON.stringify(result.error)}`);
		}

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
						this.logger.info(
							`[${this.profile.name}:${this.guildId}] session went idle, will restart`,
						);
						return;
					}
				}
				if (typed.type === "session.error") {
					const err = typed as EventSessionError;
					if (err.properties.sessionID === sessionId) {
						this.logger.error(
							`[${this.profile.name}:${this.guildId}] session error event`,
							err.properties,
						);
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
		const sessionKey = `__polling__:${this.guildId}`;
		let realId = this.sessionStore.get(this.profile.name, sessionKey);

		if (realId) {
			const result = await oc.session.get({ sessionID: realId });
			if (result.error || !result.data) {
				realId = undefined;
			}
		}

		if (realId) {
			const row = this.sessionStore.getRow(this.profile.name, sessionKey);
			this.sessionCreatedAt = row?.createdAt ?? Date.now();
		} else {
			const created = await oc.session.create({
				title: `ふあ:${this.profile.name}:${this.guildId}`,
			});
			if (created.error || !created.data) {
				throw new Error(
					`Failed to create session: ${created.error ? JSON.stringify(created.error) : "no data returned"}`,
				);
			}
			realId = created.data.id;
			await this.sessionStore.save(this.profile.name, sessionKey, realId);
			this.sessionCreatedAt = Date.now();
		}

		return realId;
	}

	private async rotateSessionIfExpired(): Promise<void> {
		if (this.sessionCreatedAt === null) return;
		const age = Date.now() - this.sessionCreatedAt;
		if (age < this.sessionMaxAgeMs) return;

		const sessionKey = `__polling__:${this.guildId}`;
		const sessionId = this.sessionStore.get(this.profile.name, sessionKey);
		if (!sessionId) return;

		const oc = await this.getClient();
		try {
			await oc.session.delete({ sessionID: sessionId });
		} catch (err) {
			this.logger.error(
				`[${this.profile.name}:${this.guildId}] failed to delete OpenCode session`,
				err,
			);
		}

		await this.sessionStore.delete(this.profile.name, sessionKey);
		this.sessionCreatedAt = null;

		const hours = Math.round(age / 3_600_000);
		this.logger.info(`[${this.profile.name}:${this.guildId}] session rotated after ${hours}h`);
	}

	private async getClient(): Promise<OpencodeClient> {
		if (this.client) return this.client;

		const result = await createOpencode({
			port: this.port,
			config: {
				mcp: this.profile.mcpServers,
				tools: this.profile.builtinTools,
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
