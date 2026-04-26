/* oxlint-disable max-lines, max-lines-per-function -- AgentRunner のメッセージ駆動ループ・セッション管理が密結合のため分割困難 */
import { classifyErrorType, METRIC, recordTokenMetrics } from "@vicissitude/observability/metrics";
import { JST_OFFSET_MS, raceAbort } from "@vicissitude/shared/functions";
import type {
	AgentResponse,
	AiAgent,
	Attachment,
	ContextBuilderPort,
	Logger,
	MetricsCollector,
	OpencodeSessionEvent,
	OpencodeSessionPort,
	SendOptions,
	SessionStorePort,
	SessionSummaryWriter,
} from "@vicissitude/shared/types";

import type { AgentProfile } from "./profile.ts";

const MAX_RECONNECT_DELAY_MS = 10_000;
const INITIAL_RECONNECT_DELAY_MS = 2_000;
const IDLE_COOLDOWN_MS = 2_000;
const DEFAULT_SUMMARY_TIMEOUT_MS = 30_000;
const MESSAGE_DEBOUNCE_MS = 500;
const MAX_DEBOUNCE_MS = 10_000;
const BOT_MAX_DEBOUNCE_MS = 30_000;

export interface RunnerDeps {
	profile: AgentProfile;
	agentId: string;
	sessionStore: SessionStorePort;
	contextBuilder: ContextBuilderPort;
	logger: Logger;
	sessionPort: OpencodeSessionPort;
	sessionMaxAgeMs: number;
	metrics?: MetricsCollector;
	/** ContextBuilder に渡す guildId（Discord エージェント用）。省略時は undefined */
	contextGuildId?: string;
	/** セッション要約の書き出しポート。省略時は要約生成をスキップ */
	summaryWriter?: SessionSummaryWriter;
	/** セッション要約生成 (`sessionPort.prompt`) のタイムアウト（ms）。壊れたセッションで summary が永久に返らないときに rotation を止めないため必須。デフォルト: 30_000 */
	summaryTimeoutMs?: number;
	/** proactive compaction のトークン閾値（input + output）。省略時は proactive compaction 無効 */
	compactionTokenThreshold?: number;
	/** compaction 間のクールダウン（ms）。デフォルト: 1_800_000 (30分) */
	compactionCooldownMs?: number;
	/** テスト用時刻プロバイダー。デフォルト: Date.now */
	nowProvider?: () => number;
}

export class AgentRunner implements AiAgent {
	private abortController: AbortController | null = null;
	private sessionAbortController: AbortController | null = null;
	private running = false;
	private sessionCreatedAt: number | null = null;
	private sessionWatch: Promise<OpencodeSessionEvent> | null = null;
	private hasStartedSession = false;
	private lastRotationRequestAt: number | null = null;
	private readonly minRotationIntervalMs = 300_000;
	private retryAttempt = 0;
	private pendingMessages: Array<{ text: string; attachments?: Attachment[] }> = [];
	private pendingResolve: (() => void) | null = null;
	/** エラー時にリトライするために直前のプロンプトテキストを保持する */
	private lastPromptText: string | null = null;
	private lastPromptAttachments: Attachment[] | null = null;
	private pendingDebounceResolve: (() => void) | null = null;
	private hasBotPending = false;

	private readonly profile: AgentProfile;
	private readonly agentId: string;
	private readonly sessionStore: SessionStorePort;
	private readonly contextBuilder: ContextBuilderPort;
	private readonly logger: Logger;
	private readonly sessionPort: OpencodeSessionPort;
	private readonly sessionMaxAgeMs: number;
	private readonly metrics?: MetricsCollector;
	private readonly contextGuildId?: string;
	private readonly summaryWriter?: SessionSummaryWriter;
	private readonly summaryTimeoutMs: number;
	private readonly compactionTokenThreshold?: number;
	private readonly compactionCooldownMs: number;
	protected readonly nowProvider: () => number;
	private lastCompactionAt: number | null = null;
	protected pendingCompaction = false;
	/** compaction 後にシステムプロンプトを再注入するフラグ */
	private pendingSystemReinject = false;

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
		this.sessionMaxAgeMs = deps.sessionMaxAgeMs;
		this.metrics = deps.metrics;
		this.contextGuildId = deps.contextGuildId;
		this.summaryWriter = deps.summaryWriter;
		this.summaryTimeoutMs = deps.summaryTimeoutMs ?? DEFAULT_SUMMARY_TIMEOUT_MS;
		this.compactionTokenThreshold = deps.compactionTokenThreshold;
		this.compactionCooldownMs = deps.compactionCooldownMs ?? 1_800_000;
		this.nowProvider = deps.nowProvider ?? Date.now;
	}

	send(options: SendOptions): Promise<AgentResponse> {
		this.pendingMessages.push({ text: options.message, attachments: options.attachments });
		if (options.isBot) this.hasBotPending = true;
		this.pendingResolve?.();
		this.pendingDebounceResolve?.();

		// 推論中（sessionWatch が pending）なら中断して旧メッセージを保全
		if (this.sessionWatch) {
			if (this.lastPromptText !== null) {
				this.pendingMessages.unshift({
					text: this.lastPromptText,
					attachments: this.lastPromptAttachments ?? undefined,
				});
			}
			this.lastPromptText = null;
			this.lastPromptAttachments = null;
			this.sessionAbortController?.abort();
		}

		this.ensurePolling();
		return Promise.resolve({ text: "", sessionId: "queued" });
	}

	ensurePolling(): void {
		if (this.running) return;
		this.logger.info(`[${this.profile.name}:${this.agentId}] ensurePolling: starting message loop`);
		this.startPollingLoop().catch((err) => {
			this.logger.error(
				`[${this.profile.name}:${this.agentId}] message loop unexpectedly rejected`,
				err,
			);
		});
	}

	protected async startPollingLoop(): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.abortController = new AbortController();
		this.hasStartedSession = false;
		this.retryAttempt = 0;
		const signal = this.abortController.signal;

		let delay = INITIAL_RECONNECT_DELAY_MS;
		let prevSleepWasCapped = false;

		const resetBackoffState = () => {
			delay = INITIAL_RECONNECT_DELAY_MS;
			prevSleepWasCapped = false;
			this.retryAttempt = 0;
		};

		while (this.running && !signal.aborted) {
			try {
				// eslint-disable-next-line no-await-in-loop -- startup/restart is sequential
				await this.ensureSessionStarted(signal);
				if (!this.sessionWatch) {
					if (signal.aborted) return;
					this.logger.warn(
						`[${this.profile.name}:${this.agentId}] ensureSessionStarted returned without sessionWatch (not aborted)`,
					);
					continue;
				}

				this.logger.info(
					`[${this.profile.name}:${this.agentId}] sessionWatch started, waiting for session end event...`,
				);
				// eslint-disable-next-line no-await-in-loop -- monitor the active session until it ends
				const event = await this.sessionWatch;
				this.sessionWatch = null;
				this.logger.info(
					`[${this.profile.name}:${this.agentId}] sessionWatch resolved: type=${event.type}${event.type === "error" ? ` message=${event.message}` : ""}`,
				);
				if (signal.aborted) return;
				this.handleSessionEnd(event);
				if (event.type === "cancelled") {
					// runner stop による中断
					if (signal.aborted) return;
					// 追いメッセージによるセッション中断 → 旧+新メッセージをまとめて再プロンプト
					this.lastPromptText = null;
					this.lastPromptAttachments = null;
					this.sessionAbortController = null;
					resetBackoffState();
					continue;
				}

				if (event.type === "deleted") {
					this.metrics?.incrementCounter(METRIC.SESSION_RESTARTS, {
						reason: "session_deleted_rotation",
					});
					// eslint-disable-next-line no-await-in-loop -- rotation after external deletion
					await this.forceSessionRotation();
					resetBackoffState();
					continue;
				}

				// compacted / streamDisconnected: セッションはまだ生きており LLM がポーリングを続けているため、
				// waitForEvents を挟まず即座にセッション監視を再開する。
				// rotateSessionIfExpired もスキップする（セッション削除すると rewatch が空振りする）。
				if (event.type === "compacted" || event.type === "streamDisconnected") {
					if (event.type === "compacted") this.pendingSystemReinject = true;
					this.rewatchSession(signal);
					resetBackoffState();
					continue;
				}

				// proactive compaction: idle イベント後にトークン閾値 or 深夜帯判定
				// eslint-disable-next-line no-await-in-loop -- best-effort compaction before rotation
				if (event.type === "idle" && (await this.tryProactiveCompact(event, signal))) {
					resetBackoffState();
					continue;
				}

				// eslint-disable-next-line no-await-in-loop -- rotation only happens after session end
				await this.rotateSessionIfExpired();

				if (event.type !== "error") {
					this.lastPromptText = null;
					this.lastPromptAttachments = null;
					resetBackoffState();
					// eslint-disable-next-line no-await-in-loop -- cooldown after idle to prevent busy loop
					await this.sleep(IDLE_COOLDOWN_MS);
					continue;
				}

				// --- error イベントのエラー戦略 ---
				if (event.retryable === false) {
					// retryable:false: 即時ローテーション（バックオフなし）
					this.metrics?.incrementCounter(METRIC.SESSION_RESTARTS, {
						reason: "error_non_retryable_rotation",
					});
					// eslint-disable-next-line no-await-in-loop -- rotation after non-retryable error
					await this.forceSessionRotation({ skipSummary: true });
					resetBackoffState();
					continue;
				}

				// retryable:true / undefined: exp backoff。直前 sleep が cap かつ今回も error ならローテーション
				if (prevSleepWasCapped) {
					this.metrics?.incrementCounter(METRIC.SESSION_RESTARTS, {
						reason: "error_retryable_rotation",
					});
					// eslint-disable-next-line no-await-in-loop -- rotation after cap escalation
					await this.forceSessionRotation();
					resetBackoffState();
					continue;
				}
				this.retryAttempt += 1;
				this.metrics?.incrementCounter(METRIC.SESSION_RETRIES, {
					error_type: classifyErrorType(event),
					attempt: String(this.retryAttempt),
				});
				this.metrics?.incrementCounter(METRIC.SESSION_RESTARTS, {
					reason: "error_retryable_backoff",
				});
			} catch (err) {
				if (signal.aborted) return;
				this.logger.error(
					`[${this.profile.name}:${this.agentId}] session error, will restart`,
					err,
				);
				this.sessionWatch = null;
				// 例外時は retryable 不明のため retryable:true 扱いのバックオフ
				this.retryAttempt += 1;
				this.metrics?.incrementCounter(METRIC.SESSION_RETRIES, {
					error_type: "session_error",
					attempt: String(this.retryAttempt),
				});
				this.metrics?.incrementCounter(METRIC.SESSION_RESTARTS, {
					reason: "error_retryable_backoff",
				});
			}

			if (signal.aborted) return;

			this.logger.info(`[${this.profile.name}:${this.agentId}] restarting in ${delay}ms...`);
			// eslint-disable-next-line no-await-in-loop -- backoff delay between restarts
			await this.sleep(delay);
			const nextDelay = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
			prevSleepWasCapped = delay >= MAX_RECONNECT_DELAY_MS;
			delay = nextDelay;

			if (signal.aborted) return;
		}
	}

	async requestSessionRotation(): Promise<void> {
		const now = Date.now();
		if (
			this.lastRotationRequestAt &&
			now - this.lastRotationRequestAt < this.minRotationIntervalMs
		) {
			this.logger.debug(
				`[${this.profile.name}:${this.agentId}] session rotation throttled (${now - this.lastRotationRequestAt}ms since last)`,
			);
			return;
		}
		await this.forceSessionRotation();
	}

	async forceSessionRotation(options?: { skipSummary?: boolean }): Promise<void> {
		this.lastRotationRequestAt = Date.now();
		const sessionId = this.sessionStore.get(this.profile.name, this.sessionKey);
		if (!sessionId) return;

		if (!options?.skipSummary) {
			await this.generateSessionSummary(sessionId);
		}

		try {
			await this.sessionPort.deleteSession(sessionId);
		} catch (err) {
			this.logger.error(`[${this.profile.name}:${this.agentId}] session rotation failed`, err);
		}
		this.sessionStore.delete(this.profile.name, this.sessionKey);
		this.sessionCreatedAt = null;
		this.hasStartedSession = false;
		this.logger.info(`[${this.profile.name}:${this.agentId}] session rotated`);
	}

	stop(): void {
		this.running = false;
		this.sessionAbortController?.abort();
		this.sessionAbortController = null;
		this.abortController?.abort();
		this.abortController = null;
		this.sessionWatch = null;
		this.sessionPort.close();
	}

	/** compacted / streamDisconnected 後にイベントストリームだけ再購読する（セッションは生存中） */
	private rewatchSession(signal: AbortSignal): void {
		const sessionId = this.sessionStore.get(this.profile.name, this.sessionKey);
		if (!sessionId) {
			this.logger.warn(`[${this.profile.name}:${this.agentId}] rewatch skipped: no session`);
			return;
		}
		this.logger.info(`[${this.profile.name}:${this.agentId}] re-watching event stream`);
		this.sessionWatch = this.sessionPort.waitForSessionIdle(sessionId, signal);
	}

	private async ensureSessionStarted(signal: AbortSignal): Promise<void> {
		if (this.sessionWatch) return;

		if (this.pendingCompaction) {
			this.pendingCompaction = false;
			if (await this.triggerCompaction(signal)) return;
		}

		let text: string;
		let attachments: Attachment[];
		if (this.lastPromptText === null) {
			this.logger.info(
				`[${this.profile.name}:${this.agentId}] waiting for messages... (hasStartedSession=${this.hasStartedSession})`,
			);
			await this.waitForMessages(signal);
			if (signal.aborted) {
				this.logger.info(`[${this.profile.name}:${this.agentId}] waitForMessages aborted`);
				return;
			}
			await this.waitForDebounce(signal);
			if (signal.aborted) return;
			const drained = this.drainMessages();
			if (!drained.text && drained.attachments.length === 0) return;
			text = drained.text;
			attachments = drained.attachments;
		} else {
			// リトライ: 前回のテキストを再利用し、新着メッセージがあれば追加
			const drained = this.drainMessages();
			text = drained.text ? `${this.lastPromptText}\n---\n${drained.text}` : this.lastPromptText;
			attachments = [...(this.lastPromptAttachments ?? []), ...drained.attachments];
		}

		this.logger.info(`[${this.profile.name}:${this.agentId}] messages received, sending prompt`);

		// lastPromptText / lastPromptAttachments にはメッセージ本文のみを保存し、リトライ時の二重注入を防ぐ
		this.lastPromptText = text;
		this.lastPromptAttachments = attachments;

		const promptText = this.profile.pollingPrompt
			? `${this.profile.pollingPrompt}\n\n${text}`
			: text;

		const sessionId = await this.resolveSessionId();
		if (signal.aborted) return;

		const needsSystem = !this.hasStartedSession || this.pendingSystemReinject;
		const system = needsSystem ? await this.contextBuilder.build(this.contextGuildId) : undefined;
		if (signal.aborted) return;

		this.logger.info(`[${this.profile.name}:${this.agentId}] prompting session ${sessionId}`);

		this.sessionAbortController = new AbortController();
		const combinedSignal = AbortSignal.any([signal, this.sessionAbortController.signal]);
		this.sessionWatch = this.sessionPort.promptAsyncAndWatchSession(
			{
				sessionId,
				text: promptText,
				model: {
					providerId: this.profile.model.providerId,
					modelId: this.profile.model.modelId,
				},
				system,
				attachments: attachments.length > 0 ? attachments : undefined,
			},
			combinedSignal,
		);
		this.pendingSystemReinject = false;
		this.hasStartedSession = true;
	}

	private waitForMessages(signal: AbortSignal): Promise<void> {
		if (this.pendingMessages.length > 0) return Promise.resolve();
		return new Promise<void>((resolve) => {
			const done = () => {
				this.pendingResolve = null;
				resolve();
			};
			this.pendingResolve = done;
			signal.addEventListener("abort", done, { once: true });
		});
	}

	// oxlint-disable-next-line no-await-in-loop -- デバウンスループは意図的に逐次待機する
	protected async waitForDebounce(signal: AbortSignal): Promise<void> {
		const deadline =
			this.nowProvider() + (this.hasBotPending ? BOT_MAX_DEBOUNCE_MS : MAX_DEBOUNCE_MS);
		let messageCountBefore = this.pendingMessages.length;

		while (!signal.aborted) {
			const remaining = deadline - this.nowProvider();
			if (remaining <= 0) break;

			const waitMs = Math.min(MESSAGE_DEBOUNCE_MS, remaining);

			// sleep と新メッセージ到着を race
			// oxlint-disable-next-line no-await-in-loop -- デバウンスループは意図的に逐次待機する
			const arrived = await this.raceDebounce(waitMs, signal);

			if (signal.aborted) break;

			// 新メッセージが来ていなければデバウンス完了
			// bot メッセージが含まれる場合は deadline まで待機し続ける
			// （bot 応答は連続到着が多いため、短い silence で打ち切らない）
			if (!arrived && this.pendingMessages.length === messageCountBefore && !this.hasBotPending)
				break;
			messageCountBefore = this.pendingMessages.length;
		}
	}

	/** デバウンス待機。新メッセージが到着した場合に true を返す */
	private async raceDebounce(waitMs: number, signal: AbortSignal): Promise<boolean> {
		const MESSAGE = Symbol("message");
		const TIMER = Symbol("timer");
		const sleepPromise = this.sleep(waitMs).then(() => TIMER);
		const messagePromise = new Promise<typeof MESSAGE>((resolve) => {
			this.pendingDebounceResolve = () => resolve(MESSAGE);
		});
		let onAbort: (() => void) | undefined;
		const abortPromise = new Promise<typeof TIMER>((resolve) => {
			onAbort = () => resolve(TIMER);
			signal.addEventListener("abort", onAbort, { once: true });
		});
		const winner = await Promise.race([sleepPromise, messagePromise, abortPromise]);
		this.pendingDebounceResolve = null;
		if (onAbort) signal.removeEventListener("abort", onAbort);
		return winner === MESSAGE;
	}

	private drainMessages(): { text: string; attachments: Attachment[] } {
		const items = this.pendingMessages.splice(0);
		this.hasBotPending = false;
		return {
			text: items.map((m) => m.text).join("\n---\n"),
			attachments: items.flatMap((m) => m.attachments ?? []),
		};
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
				recordTokenMetrics(
					this.metrics,
					event.tokens,
					{
						agent_type: "polling",
						trigger: "polling",
					},
					this.profile.model.modelId,
				);
			}
			return;
		}
		if (event.type === "compacted") {
			this.logger.info(`[${this.profile.name}:${this.agentId}] session compacted`);
			return;
		}
		if (event.type === "streamDisconnected") {
			this.logger.warn(
				`[${this.profile.name}:${this.agentId}] SSE stream disconnected, will re-subscribe`,
			);
			this.metrics?.incrementCounter(METRIC.SESSION_ERRORS, {
				source: "session_event",
				error_type: "stream_disconnected",
				http_status: "unknown",
				retryable: "unknown",
				error_class: "unknown",
			});
			if (event.tokens && this.metrics) {
				recordTokenMetrics(
					this.metrics,
					event.tokens,
					{
						agent_type: "polling",
						trigger: "polling",
					},
					this.profile.model.modelId,
				);
			}
			return;
		}
		if (event.type === "deleted") {
			this.logger.warn(
				`[${this.profile.name}:${this.agentId}] session deleted externally, will rotate`,
			);
			return;
		}
		this.logger.error(`[${this.profile.name}:${this.agentId}] session error event`, event.message);
		this.metrics?.incrementCounter(METRIC.SESSION_ERRORS, {
			source: "session_event",
			error_type: classifyErrorType(event),
			http_status: typeof event.status === "number" ? String(event.status) : "unknown",
			retryable: typeof event.retryable === "boolean" ? String(event.retryable) : "unknown",
			error_class: event.errorClass ?? "unknown",
		});
	}

	/** 会話ブレイクによる compaction を試行する */
	protected async triggerCompaction(signal: AbortSignal): Promise<boolean> {
		const now = this.nowProvider();
		if (this.lastCompactionAt !== null && now - this.lastCompactionAt < this.compactionCooldownMs) {
			return false;
		}
		const sessionId = this.sessionStore.get(this.profile.name, this.sessionKey);
		if (!sessionId) return false;
		try {
			await this.sessionPort.summarizeSession(sessionId);
			this.lastCompactionAt = now;
			this.pendingSystemReinject = true;
			this.logger.info(`[${this.profile.name}:${this.agentId}] break-triggered compaction`);
			this.rewatchSession(signal);
			return true;
		} catch (err) {
			this.logger.warn(
				`[${this.profile.name}:${this.agentId}] break-triggered compaction failed`,
				err,
			);
			return false;
		}
	}

	/** proactive compaction を試行し、成功して rewatch を開始した場合に true を返す */
	private async tryProactiveCompact(
		event: OpencodeSessionEvent & { type: "idle" },
		signal: AbortSignal,
	): Promise<boolean> {
		if (!this.shouldProactiveCompact(event)) return false;
		const sessionId = this.sessionStore.get(this.profile.name, this.sessionKey);
		if (!sessionId) return false;
		try {
			await this.sessionPort.summarizeSession(sessionId);
			this.lastCompactionAt = this.nowProvider();
			this.pendingSystemReinject = true;
			this.logger.info(`[${this.profile.name}:${this.agentId}] proactive compaction triggered`);
			this.rewatchSession(signal);
			return true;
		} catch (err) {
			this.logger.warn(
				`[${this.profile.name}:${this.agentId}] proactive compaction failed, continuing normally`,
				err,
			);
			return false;
		}
	}

	private shouldProactiveCompact(event: OpencodeSessionEvent & { type: "idle" }): boolean {
		if (this.compactionTokenThreshold === undefined) return false;

		// クールダウンチェック
		const now = this.nowProvider();
		if (this.lastCompactionAt !== null && now - this.lastCompactionAt < this.compactionCooldownMs) {
			this.logger.debug(
				`[${this.profile.name}:${this.agentId}] proactive compaction skipped: cooldown`,
			);
			return false;
		}

		// トークン閾値チェック
		if (event.tokens) {
			const total = event.tokens.input + event.tokens.output;
			if (total >= this.compactionTokenThreshold) {
				return true;
			}
		}

		// 深夜帯（2:00-5:00 JST）かつセッションが sessionMaxAgeMs の半分以上経過かつトークンが閾値の半分以上
		const jstHour = new Date(now + JST_OFFSET_MS).getUTCHours();
		if (jstHour >= 2 && jstHour < 5 && this.sessionCreatedAt !== null && event.tokens) {
			const total = event.tokens.input + event.tokens.output;
			const age = now - this.sessionCreatedAt;
			if (age >= this.sessionMaxAgeMs / 2 && total >= this.compactionTokenThreshold / 2) {
				return true;
			}
		}

		return false;
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
			this.sessionCreatedAt = row?.createdAt ?? this.nowProvider();
			this.logger.info(`[${this.profile.name}:${this.agentId}] reusing existing session ${realId}`);
		} else {
			realId = await this.sessionPort.createSession(`ふあ:${this.profile.name}:${this.agentId}`);
			this.sessionStore.save(this.profile.name, this.sessionKey, realId);
			this.sessionCreatedAt = this.nowProvider();
			this.logger.info(`[${this.profile.name}:${this.agentId}] created new session ${realId}`);
		}

		return realId;
	}

	private async rotateSessionIfExpired(): Promise<void> {
		if (this.sessionCreatedAt === null) return;
		const age = this.nowProvider() - this.sessionCreatedAt;
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
		this.hasStartedSession = false;

		const hours = Math.round(age / 3_600_000);
		this.logger.info(`[${this.profile.name}:${this.agentId}] session rotated after ${hours}h`);
	}

	/**
	 * セッション要約を best-effort で生成する。
	 *
	 * 壊れたセッションでは `sessionPort.prompt` が永久に返らないケースがある。
	 * この関数は timeout + runner abort を合成した AbortSignal で prompt を打ち切り、
	 * いかなる失敗（同期 throw・reject・timeout・abort）が起きても関数全体は resolve する。
	 * これにより呼び出し元の rotation (deleteSession / sessionStore.delete) が必ず完遂する。
	 *
	 * 実装メモ: `combinedSignal` を `sessionPort.prompt` に渡して SDK 側で HTTP
	 * リクエストをキャンセルさせる。加えて、SDK 側が signal を尊重しない実装
	 * （モック・SDK 不具合）でも rotation を止めないため、runner 側でも
	 * `raceAbort` により独立して打ち切る（二重防衛）。
	 */
	private async generateSessionSummary(sessionId: string): Promise<void> {
		if (this.abortController?.signal.aborted) return;
		if (!this.contextGuildId || !this.summaryWriter || !this.profile.summaryPrompt) return;
		const timeoutSignal = AbortSignal.timeout(this.summaryTimeoutMs);
		const combinedSignal = this.abortController
			? AbortSignal.any([timeoutSignal, this.abortController.signal])
			: timeoutSignal;
		try {
			const promptPromise = this.sessionPort.prompt(
				{
					sessionId,
					text: this.profile.summaryPrompt,
					model: this.profile.model,
					tools: {},
				},
				combinedSignal,
			);
			const { text } = await raceAbort(promptPromise, combinedSignal);
			if (!text.trim()) return;
			await this.summaryWriter.write(this.contextGuildId, text);
			this.logger.info(
				`[${this.profile.name}:${this.agentId}] session summary saved for guild ${this.contextGuildId}`,
			);
		} catch (err) {
			const name = err instanceof Error ? err.name : "";
			if (name === "AbortError" || name === "TimeoutError") {
				this.logger.warn(
					`[${this.profile.name}:${this.agentId}] session summary aborted (sessionId=${sessionId}, ${name}, timeout=${this.summaryTimeoutMs}ms); continuing rotation without summary`,
					err,
				);
				return;
			}
			this.logger.error(
				`[${this.profile.name}:${this.agentId}] failed to generate session summary (sessionId=${sessionId})`,
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
