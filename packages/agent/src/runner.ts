/* oxlint-disable max-lines -- AgentRunner のポーリングループ・セッション管理が密結合のため分割困難 */
import { recordTokenMetrics } from "@vicissitude/observability/metrics";
import type {
	AgentResponse,
	AiAgent,
	ContextBuilderPort,
	EventBuffer,
	Logger,
	MetricsCollector,
	OpencodeSessionEvent,
	OpencodeSessionPort,
	SendOptions,
	SessionSummaryWriter,
} from "@vicissitude/shared/types";

import type { AgentProfile } from "./profile.ts";
import type { SessionStore } from "./session-store.ts";

const MAX_RECONNECT_DELAY_MS = 30_000;
const INITIAL_RECONNECT_DELAY_MS = 2_000;
const IDLE_COOLDOWN_MS = 2_000;

export interface RunnerDeps {
	profile: AgentProfile;
	agentId: string;
	sessionStore: SessionStore;
	contextBuilder: ContextBuilderPort;
	logger: Logger;
	sessionPort: OpencodeSessionPort;
	eventBuffer: EventBuffer;
	sessionMaxAgeMs: number;
	metrics?: MetricsCollector;
	/** ContextBuilder に渡す guildId（Discord エージェント用）。省略時は undefined */
	contextGuildId?: string;
	/** セッション要約の書き出しポート。省略時は要約生成をスキップ */
	summaryWriter?: SessionSummaryWriter;
}

export class AgentRunner implements AiAgent {
	private abortController: AbortController | null = null;
	private running = false;
	private sessionCreatedAt: number | null = null;
	private sessionWatch: Promise<OpencodeSessionEvent> | null = null;
	private hasStartedSession = false;
	private lastRotationRequestAt: number | null = null;
	private readonly minRotationIntervalMs = 300_000;

	private readonly profile: AgentProfile;
	private readonly agentId: string;
	private readonly sessionStore: SessionStore;
	private readonly contextBuilder: ContextBuilderPort;
	private readonly logger: Logger;
	private readonly sessionPort: OpencodeSessionPort;
	private readonly eventBuffer: EventBuffer;
	private readonly sessionMaxAgeMs: number;
	private readonly metrics?: MetricsCollector;
	private readonly contextGuildId?: string;
	private readonly summaryWriter?: SessionSummaryWriter;

	private get sessionKey(): string {
		return `__polling__:${this.agentId}`;
	}

	protected constructor(deps: RunnerDeps) {
		this.profile = deps.profile;
		this.agentId = deps.agentId;
		this.sessionStore = deps.sessionStore;
		this.contextBuilder = deps.contextBuilder;
		this.logger = deps.logger;
		this.sessionPort = deps.sessionPort;
		this.eventBuffer = deps.eventBuffer;
		this.sessionMaxAgeMs = deps.sessionMaxAgeMs;
		this.metrics = deps.metrics;
		this.contextGuildId = deps.contextGuildId;
		this.summaryWriter = deps.summaryWriter;
	}

	send(options: SendOptions): Promise<AgentResponse> {
		const { message, attachments } = options;
		this.eventBuffer.append({
			ts: new Date().toISOString(),
			authorId: "system",
			authorName: "system",
			messageId: `send-${Date.now()}`,
			content: message,
			attachments: attachments && attachments.length > 0 ? attachments : undefined,
		});
		this.ensurePolling();
		return Promise.resolve({ text: "", sessionId: "polling" });
	}

	/**
	 * ポーリングループが未起動なら起動する。
	 * 通常は `send()` 経由で自動起動される。
	 * タイマーベース EventBuffer など `send()` なしで起動が必要な場合のみ直接呼ぶ。
	 */
	ensurePolling(): void {
		if (this.running) return;
		this.logger.info(`[${this.profile.name}:${this.agentId}] ensurePolling: starting polling loop`);
		this.startPollingLoop().catch((err) => {
			this.logger.error(
				`[${this.profile.name}:${this.agentId}] polling loop unexpectedly rejected`,
				err,
			);
		});
	}

	protected async startPollingLoop(): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.abortController = new AbortController();
		this.hasStartedSession = false;
		const signal = this.abortController.signal;

		let delay = INITIAL_RECONNECT_DELAY_MS;

		while (this.running && !signal.aborted) {
			try {
				// eslint-disable-next-line no-await-in-loop -- startup/restart is sequential
				await this.ensureSessionStarted(signal);
				if (!this.sessionWatch) {
					if (signal.aborted) return;
					continue;
				}

				// eslint-disable-next-line no-await-in-loop -- monitor the active session until it ends
				const event = await this.sessionWatch;
				this.sessionWatch = null;
				if (signal.aborted) return;
				this.handleSessionEnd(event);
				if (event.type === "cancelled") return;

				// compacted: セッションはまだ生きており LLM がポーリングを続けているため、
				// waitForEvents を挟まず即座にセッション監視を再開する。
				// rotateSessionIfExpired もスキップする（セッション削除すると rewatch が空振りする）。
				if (event.type === "compacted") {
					this.rewatchSession(signal);
					delay = INITIAL_RECONNECT_DELAY_MS;
					continue;
				}

				// eslint-disable-next-line no-await-in-loop -- rotation only happens after session end
				await this.rotateSessionIfExpired();

				if (event.type !== "error") {
					delay = INITIAL_RECONNECT_DELAY_MS;
					// eslint-disable-next-line no-await-in-loop -- cooldown after idle to prevent busy loop
					await this.sleep(IDLE_COOLDOWN_MS);
					continue;
				}
			} catch (err) {
				if (signal.aborted) return;
				this.logger.error(
					`[${this.profile.name}:${this.agentId}] session error, will restart`,
					err,
				);
				this.sessionWatch = null;
			}

			if (signal.aborted) return;

			this.logger.info(`[${this.profile.name}:${this.agentId}] restarting in ${delay}ms...`);
			// eslint-disable-next-line no-await-in-loop -- backoff delay between restarts
			await this.sleep(delay);
			delay = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
		}
	}

	async requestSessionRotation(): Promise<void> {
		const now = Date.now();
		if (
			this.lastRotationRequestAt &&
			now - this.lastRotationRequestAt < this.minRotationIntervalMs
		) {
			return;
		}
		this.lastRotationRequestAt = now;
		const sessionId = this.sessionStore.get(this.profile.name, this.sessionKey);
		if (!sessionId) return;

		await this.generateSessionSummary(sessionId);

		try {
			await this.sessionPort.deleteSession(sessionId);
		} catch (err) {
			this.logger.error(`[${this.profile.name}:${this.agentId}] forced rotation failed`, err);
		}
		this.sessionStore.delete(this.profile.name, this.sessionKey);
		this.sessionCreatedAt = null;
		this.logger.info(
			`[${this.profile.name}:${this.agentId}] session force-rotated (stuck recovery)`,
		);
	}

	stop(): void {
		this.running = false;
		this.abortController?.abort();
		this.abortController = null;
		this.sessionWatch = null;
		this.sessionPort.close();
	}

	/** compacted 後にイベントストリームだけ再購読する（セッションは生存中） */
	private rewatchSession(signal: AbortSignal): void {
		const sessionId = this.sessionStore.get(this.profile.name, this.sessionKey);
		if (!sessionId) {
			this.logger.warn(`[${this.profile.name}:${this.agentId}] rewatch skipped: no session`);
			return;
		}
		this.logger.info(`[${this.profile.name}:${this.agentId}] re-watching after compaction`);
		this.sessionWatch = this.sessionPort.waitForSessionIdle(sessionId, signal);
	}

	private async startLongLivedSession(signal: AbortSignal): Promise<void> {
		const sessionId = await this.resolveSessionId();
		if (signal.aborted) return;

		const system = await this.contextBuilder.build(this.contextGuildId);
		if (signal.aborted) return;

		this.logger.info(
			`[${this.profile.name}:${this.agentId}] starting polling prompt on session ${sessionId}`,
		);

		this.sessionWatch = this.sessionPort.promptAsyncAndWatchSession(
			{
				sessionId,
				text: this.profile.pollingPrompt,
				model: {
					providerId: this.profile.model.providerId,
					modelId: this.profile.model.modelId,
				},
				system,
			},
			signal,
		);
	}

	private async ensureSessionStarted(signal: AbortSignal): Promise<void> {
		if (this.sessionWatch) return;
		if (this.hasStartedSession && this.profile.restartPolicy === "immediate") {
			this.logger.info(`[${this.profile.name}:${this.agentId}] restarting long-lived session`);
			await this.startLongLivedSession(signal);
			return;
		}

		this.logger.info(`[${this.profile.name}:${this.agentId}] waiting for events...`);
		await this.eventBuffer.waitForEvents(signal);
		if (signal.aborted) return;
		this.logger.info(`[${this.profile.name}:${this.agentId}] events detected, starting session`);
		await this.startLongLivedSession(signal);
		if (signal.aborted || !this.sessionWatch) return;
		this.hasStartedSession = true;
	}

	private handleSessionEnd(event: OpencodeSessionEvent): void {
		if (event.type === "cancelled") {
			return;
		}
		if (event.type === "idle") {
			this.logger.info(
				`[${this.profile.name}:${this.agentId}] long-lived session went idle, will restart`,
			);
			if (event.tokens && this.metrics) {
				recordTokenMetrics(this.metrics, event.tokens, {
					agent_type: "polling",
					trigger: "polling",
				});
			}
			return;
		}
		if (event.type === "compacted") {
			this.logger.info(`[${this.profile.name}:${this.agentId}] session compacted`);
			return;
		}
		this.logger.error(`[${this.profile.name}:${this.agentId}] session error event`, event.message);
	}

	private async resolveSessionId(): Promise<string> {
		let realId = this.sessionStore.get(this.profile.name, this.sessionKey);

		if (realId) {
			const exists = await this.sessionPort.sessionExists(realId);
			if (!exists) {
				realId = undefined;
			}
		}

		if (realId) {
			const row = this.sessionStore.getRow(this.profile.name, this.sessionKey);
			this.sessionCreatedAt = row?.createdAt ?? Date.now();
			this.logger.info(`[${this.profile.name}:${this.agentId}] reusing existing session ${realId}`);
		} else {
			realId = await this.sessionPort.createSession(`ふあ:${this.profile.name}:${this.agentId}`);
			this.sessionStore.save(this.profile.name, this.sessionKey, realId);
			this.sessionCreatedAt = Date.now();
			this.logger.info(`[${this.profile.name}:${this.agentId}] created new session ${realId}`);
		}

		return realId;
	}

	private async rotateSessionIfExpired(): Promise<void> {
		if (this.sessionCreatedAt === null) return;
		const age = Date.now() - this.sessionCreatedAt;
		if (age < this.sessionMaxAgeMs) return;

		const sessionId = this.sessionStore.get(this.profile.name, this.sessionKey);
		if (!sessionId) return;

		await this.generateSessionSummary(sessionId);

		try {
			await this.sessionPort.deleteSession(sessionId);
		} catch (err) {
			this.logger.error(
				`[${this.profile.name}:${this.agentId}] failed to delete OpenCode session`,
				err,
			);
		}

		this.sessionStore.delete(this.profile.name, this.sessionKey);
		this.sessionCreatedAt = null;

		const hours = Math.round(age / 3_600_000);
		this.logger.info(`[${this.profile.name}:${this.agentId}] session rotated after ${hours}h`);
	}

	private async generateSessionSummary(sessionId: string): Promise<void> {
		if (this.abortController?.signal.aborted) return;
		if (!this.contextGuildId || !this.summaryWriter || !this.profile.summaryPrompt) return;
		try {
			const { text } = await this.sessionPort.prompt({
				sessionId,
				text: this.profile.summaryPrompt,
				model: this.profile.model,
				tools: {},
			});
			if (!text.trim()) return;
			await this.summaryWriter.write(this.contextGuildId, text);
			this.logger.info(
				`[${this.profile.name}:${this.agentId}] session summary saved for guild ${this.contextGuildId}`,
			);
		} catch (err) {
			this.logger.error(
				`[${this.profile.name}:${this.agentId}] failed to generate session summary`,
				err,
			);
		}
	}

	protected sleep(ms: number): Promise<void> {
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
