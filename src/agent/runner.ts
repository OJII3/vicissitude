import type {
	AgentResponse,
	ContextBuilderPort,
	EventBuffer,
	Logger,
	OpencodeSessionPort,
} from "../core/types.ts";
import type { AgentProfile } from "./profile.ts";
import type { AiAgent, SendOptions } from "./router.ts";
import type { SessionStore } from "./session-store.ts";

const MAX_RECONNECT_DELAY_MS = 30_000;
const INITIAL_RECONNECT_DELAY_MS = 2_000;

export interface RunnerDeps {
	profile: AgentProfile;
	guildId: string;
	sessionStore: SessionStore;
	contextBuilder: ContextBuilderPort;
	logger: Logger;
	sessionPort: OpencodeSessionPort;
	eventBuffer: EventBuffer;
	sessionMaxAgeMs: number;
}

export class AgentRunner implements AiAgent {
	private abortController: AbortController | null = null;
	private running = false;
	private sessionCreatedAt: number | null = null;

	private readonly profile: AgentProfile;
	private readonly guildId: string;
	private readonly sessionStore: SessionStore;
	private readonly contextBuilder: ContextBuilderPort;
	private readonly logger: Logger;
	private readonly sessionPort: OpencodeSessionPort;
	private readonly eventBuffer: EventBuffer;
	private readonly sessionMaxAgeMs: number;

	constructor(deps: RunnerDeps) {
		this.profile = deps.profile;
		this.guildId = deps.guildId;
		this.sessionStore = deps.sessionStore;
		this.contextBuilder = deps.contextBuilder;
		this.logger = deps.logger;
		this.sessionPort = deps.sessionPort;
		this.eventBuffer = deps.eventBuffer;
		this.sessionMaxAgeMs = deps.sessionMaxAgeMs;
	}

	send(options: SendOptions): Promise<AgentResponse> {
		const { message, guildId, attachments } = options;
		this.eventBuffer.append({
			ts: new Date().toISOString(),
			channelId: "system",
			guildId: guildId ?? this.guildId,
			authorId: "system",
			authorName: "system",
			messageId: `send-${Date.now()}`,
			content: message,
			attachments: attachments && attachments.length > 0 ? attachments : undefined,
			isBot: false,
			isMentioned: false,
			isThread: false,
		});
		return Promise.resolve({ text: "", sessionId: "polling" });
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
				// skip backoff delay on normal session completion
				continue;
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
		this.sessionPort.close();
	}

	private async runPollingSession(): Promise<void> {
		const sessionId = await this.resolveSessionId();

		const system = await this.contextBuilder.build(this.guildId);

		this.logger.info(
			`[${this.profile.name}:${this.guildId}] starting polling prompt on session ${sessionId}`,
		);

		await this.sessionPort.promptAsync({
			sessionId,
			text: this.profile.pollingPrompt,
			model: {
				providerId: this.profile.model.providerId,
				modelId: this.profile.model.modelId,
			},
			system,
		});

		const event = await this.sessionPort.waitForSessionIdle(
			sessionId,
			this.abortController?.signal,
		);

		if (event.type === "cancelled") {
			// abort による中断、ログ不要
		} else if (event.type === "idle") {
			this.logger.info(`[${this.profile.name}:${this.guildId}] session went idle, will restart`);
		} else if (event.type === "compacted") {
			this.logger.info(`[${this.profile.name}:${this.guildId}] session compacted`);
		} else if (event.type === "error") {
			this.logger.error(
				`[${this.profile.name}:${this.guildId}] session error event`,
				event.message,
			);
		}
	}

	private async resolveSessionId(): Promise<string> {
		const sessionKey = `__polling__:${this.guildId}`;
		let realId = this.sessionStore.get(this.profile.name, sessionKey);

		if (realId) {
			const exists = await this.sessionPort.sessionExists(realId);
			if (!exists) {
				realId = undefined;
			}
		}

		if (realId) {
			const row = this.sessionStore.getRow(this.profile.name, sessionKey);
			this.sessionCreatedAt = row?.createdAt ?? Date.now();
		} else {
			realId = await this.sessionPort.createSession(`ふあ:${this.profile.name}:${this.guildId}`);
			this.sessionStore.save(this.profile.name, sessionKey, realId);
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

		try {
			await this.sessionPort.deleteSession(sessionId);
		} catch (err) {
			this.logger.error(
				`[${this.profile.name}:${this.guildId}] failed to delete OpenCode session`,
				err,
			);
		}

		this.sessionStore.delete(this.profile.name, sessionKey);
		this.sessionCreatedAt = null;

		const hours = Math.round(age / 3_600_000);
		this.logger.info(`[${this.profile.name}:${this.guildId}] session rotated after ${hours}h`);
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
