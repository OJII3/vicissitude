/* oxlint-disable max-lines, max-lines-per-function -- startPollingLoop のエラー戦略分岐とセッションライフサイクルが密結合のため分割困難（メトリクス・compaction 判定・メッセージキューは別モジュールへ抽出済み） */
import {
	classifyErrorType,
	inferScopeId,
	inferTrigger,
	METRIC,
	recordTokenMetrics,
} from "@vicissitude/observability/metrics";
import { formatErrorMessage, raceAbort, sleep } from "@vicissitude/shared/functions";
import type {
	AgentResponse,
	AiAgent,
	Attachment,
	AttachmentProcessor,
	ContextBuilderPort,
	Logger,
	MetricsCollector,
	OpencodeSessionActivity,
	OpencodeSessionEvent,
	OpencodeSessionPort,
	SendOptions,
	SessionStorePort,
	SessionSummaryWriter,
} from "@vicissitude/shared/types";

import type { AgentProfile } from "./profile.ts";
import { evaluateProactiveCompaction, isCompactionOnCooldown } from "./runner-compaction.ts";
import { MessageBuffer } from "./runner-message-buffer.ts";
import { PromptMetricsTracker } from "./runner-prompt-metrics.ts";

const MAX_RECONNECT_DELAY_MS = 10_000;
const INITIAL_RECONNECT_DELAY_MS = 2_000;
const IDLE_COOLDOWN_MS = 2_000;
const DEFAULT_SUMMARY_TIMEOUT_MS = 30_000;
const MESSAGE_DEBOUNCE_MS = 500;
const MAX_DEBOUNCE_MS = 10_000;
const BOT_MAX_DEBOUNCE_MS = 30_000;
const UNINTERRUPTIBLE_DISCORD_TOOLS = new Set(["discord_send_message", "discord_reply"]);
const IRRECOVERABLE_SESSION_ERROR_CLASSES = new Set(["ImageInvalidDataUrlError"]);

function isIrrecoverableSessionError(
	event: Extract<OpencodeSessionEvent, { type: "error" }>,
): boolean {
	return (
		event.errorClass !== undefined && IRRECOVERABLE_SESSION_ERROR_CLASSES.has(event.errorClass)
	);
}

export interface RunnerDeps {
	profile: AgentProfile;
	agentId: string;
	sessionStore: SessionStorePort;
	contextBuilder: ContextBuilderPort;
	logger: Logger;
	sessionPort: OpencodeSessionPort;
	sessionMaxAgeMs: number;
	metrics?: MetricsCollector;
	/** ContextBuilder に渡す scopeId。省略時は undefined */
	contextScopeId?: string;
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
	/** 添付を通常プロンプト投入前に処理する。Discord の画像認識補助などで使用 */
	attachmentProcessor?: AttachmentProcessor;
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
	private readonly messages = new MessageBuffer();
	/** @internal ホワイトボックステスト用シーム。外部から直接参照しないこと */
	private get hasBotPending(): boolean {
		return this.messages.hasBotPending;
	}
	private pendingResolve: (() => void) | null = null;
	private pendingDebounceResolve: (() => void) | null = null;
	private promptHasUninterruptibleSideEffect = false;
	private reportedBackgroundTaskFailures = new Set<string>();

	private readonly profile: AgentProfile;
	private readonly agentId: string;
	private readonly sessionStore: SessionStorePort;
	private readonly contextBuilder: ContextBuilderPort;
	private readonly logger: Logger;
	private readonly sessionPort: OpencodeSessionPort;
	private readonly sessionMaxAgeMs: number;
	private readonly metrics?: MetricsCollector;
	private readonly promptMetrics: PromptMetricsTracker;
	private readonly contextScopeId?: string;
	private readonly summaryWriter?: SessionSummaryWriter;
	private readonly summaryTimeoutMs: number;
	private readonly compactionTokenThreshold?: number;
	private readonly compactionCooldownMs: number;
	private readonly attachmentProcessor?: AttachmentProcessor;
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
		this.contextScopeId = deps.contextScopeId;
		this.summaryWriter = deps.summaryWriter;
		this.summaryTimeoutMs = deps.summaryTimeoutMs ?? DEFAULT_SUMMARY_TIMEOUT_MS;
		this.compactionTokenThreshold = deps.compactionTokenThreshold;
		this.compactionCooldownMs = deps.compactionCooldownMs ?? 1_800_000;
		this.attachmentProcessor = deps.attachmentProcessor;
		this.nowProvider = deps.nowProvider ?? Date.now;
		this.promptMetrics = new PromptMetricsTracker({
			metrics: deps.metrics,
			agentId: deps.agentId,
			contextScopeId: deps.contextScopeId,
			model: deps.profile.model,
		});
	}

	send(options: SendOptions): Promise<AgentResponse> {
		this.messages.enqueue(
			{
				text: options.message,
				attachments: options.attachments,
				trigger: inferTrigger(options.sessionKey),
				scopeId: options.scopeId ?? inferScopeId(options.sessionKey) ?? this.contextScopeId,
			},
			options.isBot ?? false,
		);
		this.pendingResolve?.();
		this.pendingDebounceResolve?.();

		// 推論中（sessionWatch が pending）なら中断して旧メッセージを保全。
		// ただし Discord 送信系 tool が開始済みなら、外部副作用が巻き戻せないため
		// 現在の turn を最後まで待ち、新着は次 turn に回す。
		if (this.sessionWatch) {
			if (this.promptHasUninterruptibleSideEffect) {
				this.ensurePolling();
				return Promise.resolve({ text: "", sessionId: "queued" });
			}
			this.messages.requeueLastPrompt();
			this.messages.clearLastPrompt();
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
					this.promptMetrics.finalize("cancelled");
					// runner stop による中断
					if (signal.aborted) return;
					// 追いメッセージによるセッション中断 → 旧+新メッセージをまとめて再プロンプト
					this.messages.clearLastPrompt();
					this.promptHasUninterruptibleSideEffect = false;
					this.sessionAbortController = null;
					resetBackoffState();
					continue;
				}

				if (event.type === "deleted") {
					this.metrics?.incrementCounter(
						METRIC.SESSION_RESTARTS,
						this.promptMetrics.labels({
							reason: "session_deleted_rotation",
						}),
					);
					this.promptMetrics.finalize("deleted");
					if (this.promptHasUninterruptibleSideEffect) this.messages.clearLastPrompt();
					this.promptHasUninterruptibleSideEffect = false;
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
				if (event.type === "idle") {
					this.promptMetrics.finalize("success");
					// eslint-disable-next-line no-await-in-loop -- best-effort compaction before rotation
					await this.tryProactiveCompact(event);
				}

				// eslint-disable-next-line no-await-in-loop -- rotation only happens after session end
				await this.rotateSessionIfExpired();

				if (event.type !== "error") {
					this.messages.clearLastPrompt();
					this.promptHasUninterruptibleSideEffect = false;
					resetBackoffState();
					// eslint-disable-next-line no-await-in-loop -- cooldown after idle to prevent busy loop
					await this.sleep(IDLE_COOLDOWN_MS);
					continue;
				}

				// --- error イベントのエラー戦略 ---
				const irrecoverableSessionError = isIrrecoverableSessionError(event);
				if (event.retryable === false || irrecoverableSessionError) {
					// retryable:false / session 破損系エラー: 即時ローテーション（バックオフなし）
					// retryable:false 判定を優先し、それ以外で irrecoverable なら破損系 reason を使う
					const reason =
						event.retryable === false
							? "error_non_retryable_rotation"
							: "error_irrecoverable_rotation";
					this.metrics?.incrementCounter(
						METRIC.SESSION_RESTARTS,
						this.promptMetrics.labels({ reason }),
					);
					this.promptMetrics.finalize("error");
					if (this.promptHasUninterruptibleSideEffect) this.messages.clearLastPrompt();
					this.promptHasUninterruptibleSideEffect = false;
					if (reason === "error_irrecoverable_rotation") {
						this.logger.warn(
							`[${this.profile.name}:${this.agentId}] forcing session rotation after irrecoverable session error`,
							event.message,
						);
					}
					// eslint-disable-next-line no-await-in-loop -- rotation after irrecoverable error
					await this.forceSessionRotation({ skipSummary: true });
					resetBackoffState();
					continue;
				}

				if (this.promptHasUninterruptibleSideEffect) {
					this.promptMetrics.finalize("error");
					this.messages.clearLastPrompt();
					this.promptHasUninterruptibleSideEffect = false;
					resetBackoffState();
					// eslint-disable-next-line no-await-in-loop -- avoid retrying a prompt that may have sent Discord messages
					await this.sleep(IDLE_COOLDOWN_MS);
					continue;
				}

				// retryable:true / undefined: exp backoff。直前 sleep が cap かつ今回も error ならローテーション
				if (prevSleepWasCapped) {
					this.metrics?.incrementCounter(
						METRIC.SESSION_RESTARTS,
						this.promptMetrics.labels({
							reason: "error_retryable_rotation",
						}),
					);
					this.promptMetrics.finalize("error");
					// eslint-disable-next-line no-await-in-loop -- rotation after cap escalation
					await this.forceSessionRotation();
					resetBackoffState();
					continue;
				}
				this.retryAttempt += 1;
				this.metrics?.incrementCounter(
					METRIC.SESSION_RETRIES,
					this.promptMetrics.labels({
						error_type: classifyErrorType(event),
						attempt: String(this.retryAttempt),
					}),
				);
				this.metrics?.incrementCounter(
					METRIC.SESSION_RESTARTS,
					this.promptMetrics.labels({
						reason: "error_retryable_backoff",
					}),
				);
				this.promptMetrics.finalize("error");
			} catch (err) {
				if (signal.aborted) return;
				this.logger.error(
					`[${this.profile.name}:${this.agentId}] session error, will restart`,
					err,
				);
				this.sessionWatch = null;
				this.metrics?.incrementCounter(
					METRIC.SESSION_ERRORS,
					this.promptMetrics.labels({
						source: "runner_exception",
						error_type: "session_error",
						http_status: "unknown",
						retryable: "unknown",
						error_class: err instanceof Error ? err.name : "unknown",
					}),
				);
				this.promptMetrics.finalize("error");
				if (this.promptHasUninterruptibleSideEffect) {
					this.messages.clearLastPrompt();
					this.promptHasUninterruptibleSideEffect = false;
					resetBackoffState();
					// eslint-disable-next-line no-await-in-loop -- avoid retrying a prompt that may have sent Discord messages
					await this.sleep(IDLE_COOLDOWN_MS);
					continue;
				}
				// 例外時は retryable 不明のため retryable:true 扱いのバックオフ
				this.retryAttempt += 1;
				this.metrics?.incrementCounter(
					METRIC.SESSION_RETRIES,
					this.promptMetrics.labels({
						error_type: "session_error",
						attempt: String(this.retryAttempt),
					}),
				);
				this.metrics?.incrementCounter(
					METRIC.SESSION_RESTARTS,
					this.promptMetrics.labels({
						reason: "error_retryable_backoff",
					}),
				);
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
		this.promptMetrics.finalize("cancelled");
		this.sessionAbortController?.abort();
		this.sessionAbortController = null;
		this.abortController?.abort();
		this.abortController = null;
		this.sessionWatch = null;
		this.promptHasUninterruptibleSideEffect = false;
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
		this.sessionWatch = this.sessionPort.waitForSessionIdle(sessionId, signal, (activity) =>
			this.handleSessionActivity(activity),
		);
	}

	private handleSessionActivity(activity: OpencodeSessionActivity): void {
		if (
			activity.type === "tool" &&
			activity.status === "running" &&
			UNINTERRUPTIBLE_DISCORD_TOOLS.has(activity.tool)
		) {
			this.promptHasUninterruptibleSideEffect = true;
			return;
		}
		if (activity.type === "backgroundTaskFailure") {
			this.handleBackgroundTaskFailure(activity);
		}
	}

	private handleBackgroundTaskFailure(
		activity: Extract<OpencodeSessionActivity, { type: "backgroundTaskFailure" }>,
	): void {
		const key = `${activity.taskId ?? "unknown"}:${activity.reason}:${activity.message}`;
		if (this.reportedBackgroundTaskFailures.has(key)) return;
		this.reportedBackgroundTaskFailures.add(key);
		this.logger.error(
			`[${this.profile.name}:${this.agentId}] shell-worker background task failed`,
			activity.message,
		);
		this.metrics?.incrementCounter(
			METRIC.SESSION_ERRORS,
			this.promptMetrics.labels({
				source: "background_task",
				error_type: activity.reason,
				http_status: "unknown",
				retryable: "unknown",
				error_class: "BackgroundTaskFailure",
			}),
		);
		this.messages.enqueue(
			{
				text: `<internal_message>
shell-worker background task failed.
task_id: ${activity.taskId ?? "unknown"}
state: ${activity.state ?? "unknown"}
reason: ${activity.reason}
detail: ${activity.message}

この shell-worker 作業を成功・開始済みとして報告してはいけません。Discord には失敗として短く報告してください。
</internal_message>`,
				trigger: "internal",
				scopeId: this.contextScopeId,
			},
			false,
		);
		this.pendingResolve?.();
		this.pendingDebounceResolve?.();

		if (!this.sessionWatch || this.promptHasUninterruptibleSideEffect) {
			this.ensurePolling();
			return;
		}
		this.messages.requeueLastPrompt();
		this.messages.clearLastPrompt();
		this.sessionAbortController?.abort();
	}

	private async ensureSessionStarted(signal: AbortSignal): Promise<void> {
		if (this.sessionWatch) return;

		if (this.pendingCompaction) {
			this.pendingCompaction = false;
			await this.triggerCompaction();
			if (signal.aborted) return;
		}

		let text: string;
		let attachments: Attachment[];
		let trigger: string;
		let scopeId: string | undefined;
		if (this.messages.hasLastPrompt) {
			// リトライ: 前回のテキストを再利用し、新着メッセージがあれば追加
			const drained = this.messages.drainForRetry(this.contextScopeId);
			text = drained.text;
			attachments = drained.attachments;
			trigger = drained.trigger;
			scopeId = drained.scopeId;
		} else {
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
			const drained = this.messages.drain(this.contextScopeId);
			if (!drained.text && drained.attachments.length === 0) return;
			text = drained.text;
			attachments = drained.attachments;
			trigger = drained.trigger;
			scopeId = drained.scopeId;
		}

		this.promptMetrics.setPendingLabels(trigger, scopeId);
		this.logger.info(`[${this.profile.name}:${this.agentId}] messages received, sending prompt`);

		if (this.attachmentProcessor) {
			const processed = await this.attachmentProcessor.process(text, attachments);
			if (signal.aborted) return;
			text = processed.text;
			attachments = processed.attachments;
		}

		// lastPrompt にはメッセージ本文のみを保存し、リトライ時の二重注入を防ぐ
		this.messages.setLastPrompt(text, attachments, trigger, scopeId);

		const turnPromptPrefix = await this.contextBuilder.buildTurnPromptPrefix?.();
		if (signal.aborted) return;
		const promptText = [turnPromptPrefix, this.profile.pollingPrompt, text]
			.filter((part): part is string => typeof part === "string" && part.trim().length > 0)
			.join("\n\n");

		const sessionId = await this.resolveSessionId();
		if (signal.aborted) return;

		const needsSystem = !this.hasStartedSession || this.pendingSystemReinject;
		const system = needsSystem ? await this.contextBuilder.build(this.contextScopeId) : undefined;
		if (signal.aborted) return;

		this.logger.info(`[${this.profile.name}:${this.agentId}] prompting session ${sessionId}`);

		this.sessionAbortController = new AbortController();
		const combinedSignal = AbortSignal.any([signal, this.sessionAbortController.signal]);
		this.promptHasUninterruptibleSideEffect = false;
		this.promptMetrics.start(trigger, scopeId);
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
				onActivity: (activity) => this.handleSessionActivity(activity),
			},
			combinedSignal,
		);
		this.pendingSystemReinject = false;
		this.hasStartedSession = true;
	}

	private waitForMessages(signal: AbortSignal): Promise<void> {
		if (this.messages.size > 0) return Promise.resolve();
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
			this.nowProvider() + (this.messages.hasBotPending ? BOT_MAX_DEBOUNCE_MS : MAX_DEBOUNCE_MS);
		let messageCountBefore = this.messages.size;

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
			if (!arrived && this.messages.size === messageCountBefore && !this.messages.hasBotPending)
				break;
			messageCountBefore = this.messages.size;
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
					this.promptMetrics.labels(),
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
			this.metrics?.incrementCounter(
				METRIC.SESSION_ERRORS,
				this.promptMetrics.labels({
					source: "session_event",
					error_type: "stream_disconnected",
					http_status: "unknown",
					retryable: "unknown",
					error_class: "unknown",
				}),
			);
			if (event.tokens && this.metrics) {
				recordTokenMetrics(
					this.metrics,
					event.tokens,
					this.promptMetrics.labels(),
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
		this.metrics?.incrementCounter(
			METRIC.SESSION_ERRORS,
			this.promptMetrics.labels({
				source: "session_event",
				error_type: classifyErrorType(event),
				http_status: typeof event.status === "number" ? String(event.status) : "unknown",
				retryable: typeof event.retryable === "boolean" ? String(event.retryable) : "unknown",
				error_class: event.errorClass ?? "unknown",
			}),
		);
	}

	/** 会話ブレイクによる compaction を試行する */
	protected async triggerCompaction(): Promise<void> {
		const now = this.nowProvider();
		if (isCompactionOnCooldown(now, this.lastCompactionAt, this.compactionCooldownMs)) {
			return;
		}
		const sessionId = this.sessionStore.get(this.profile.name, this.sessionKey);
		if (!sessionId) return;
		try {
			await this.sessionPort.summarizeSession(sessionId, this.profile.model);
			this.lastCompactionAt = now;
			this.pendingSystemReinject = true;
			this.logger.info(
				`[${this.profile.name}:${this.agentId}] break-triggered compaction completed`,
			);
		} catch (err) {
			this.logger.warn(
				`[${this.profile.name}:${this.agentId}] break-triggered compaction failed: ${formatErrorMessage(err)}`,
			);
		}
	}

	/** proactive compaction を試行し、成功した場合は次回プロンプトで system prompt を再注入する */
	private async tryProactiveCompact(event: OpencodeSessionEvent & { type: "idle" }): Promise<void> {
		const decision = evaluateProactiveCompaction({
			compactionTokenThreshold: this.compactionTokenThreshold,
			now: this.nowProvider(),
			lastCompactionAt: this.lastCompactionAt,
			compactionCooldownMs: this.compactionCooldownMs,
			sessionCreatedAt: this.sessionCreatedAt,
			sessionMaxAgeMs: this.sessionMaxAgeMs,
			tokens: event.tokens,
		});
		if (decision === "cooldown") {
			this.logger.debug(
				`[${this.profile.name}:${this.agentId}] proactive compaction skipped: cooldown`,
			);
			return;
		}
		if (decision === "none") return;
		const sessionId = this.sessionStore.get(this.profile.name, this.sessionKey);
		if (!sessionId) return;
		try {
			await this.sessionPort.summarizeSession(sessionId, this.profile.model);
			this.lastCompactionAt = this.nowProvider();
			this.pendingSystemReinject = true;
			this.logger.info(`[${this.profile.name}:${this.agentId}] proactive compaction completed`);
		} catch (err) {
			this.logger.warn(
				`[${this.profile.name}:${this.agentId}] proactive compaction failed, continuing normally: ${formatErrorMessage(err)}`,
			);
		}
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
			realId = await this.sessionPort.createSession(
				`vicissitude:${this.profile.name}:${this.agentId}`,
			);
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
		if (!this.contextScopeId || !this.summaryWriter || !this.profile.summaryPrompt) return;
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
			await this.summaryWriter.write(this.contextScopeId, text);
			this.logger.info(
				`[${this.profile.name}:${this.agentId}] session summary saved for scope ${this.contextScopeId}`,
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
		return sleep(ms, this.abortController?.signal);
	}
}
