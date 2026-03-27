import { METRIC } from "@vicissitude/observability/metrics";
import type { MetricsCollector } from "@vicissitude/shared/types";

import { classifyFailure, totalTravelDistance } from "./helpers.ts";
import type { ActionState, Importance, JobInfo, JobStatus } from "./helpers.ts";

type PushEvent = (kind: string, description: string, importance: Importance) => void;
type SetActionState = (state: ActionState) => void;

interface CooldownInfo {
	type: Exclude<ActionState["type"], "idle">;
	until: Date;
}

export interface PositionSnapshot {
	x: number;
	y: number;
	z: number;
}

interface JobManagerOptions {
	cooldownMs?: number;
	stuckFailureThreshold?: number;
	stuckPositionThreshold?: number;
	stuckTimeMsThreshold?: number;
}

type CancellationReason = "manual" | "superseded";

export type JobExecutor = (
	signal: AbortSignal,
	updateProgress: (progress: string) => void,
) => Promise<void>;

const MAX_RECENT_JOBS = 20;
const DEFAULT_COOLDOWN_MS = 60_000;
const FAILURE_STREAK_FOR_COOLDOWN = 2;
const DEFAULT_STUCK_FAILURE_THRESHOLD = 4;
const DEFAULT_STUCK_POSITION_THRESHOLD = 3;
const DEFAULT_STUCK_TIME_MS_THRESHOLD = 300_000;
const MAX_POSITION_SNAPSHOTS = 5;

export class JobManager {
	private currentJob: {
		info: JobInfo;
		abortController: AbortController;
	} | null = null;
	private recentJobs: JobInfo[] = [];
	private nextJobId = 1;
	private readonly cooldowns = new Map<Exclude<ActionState["type"], "idle">, Date>();
	private readonly failureStreaks = new Map<Exclude<ActionState["type"], "idle">, number>();
	private readonly pushEvent: PushEvent;
	private readonly setActionState: SetActionState;
	private readonly metrics?: MetricsCollector;
	private readonly cooldownMs: number;
	private readonly stuckFailureThreshold: number;
	private readonly stuckPositionThreshold: number;
	private readonly stuckTimeMsThreshold: number;
	private positionSnapshots: PositionSnapshot[] = [];
	private stuckNotified = false;

	constructor(
		pushEvent: PushEvent,
		setActionState: SetActionState,
		metrics?: MetricsCollector,
		options?: JobManagerOptions,
	) {
		this.pushEvent = pushEvent;
		this.setActionState = setActionState;
		this.metrics = metrics;
		this.cooldownMs = options?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
		this.stuckFailureThreshold = options?.stuckFailureThreshold ?? DEFAULT_STUCK_FAILURE_THRESHOLD;
		this.stuckPositionThreshold =
			options?.stuckPositionThreshold ?? DEFAULT_STUCK_POSITION_THRESHOLD;
		this.stuckTimeMsThreshold = options?.stuckTimeMsThreshold ?? DEFAULT_STUCK_TIME_MS_THRESHOLD;
	}

	private generateJobId(): string {
		return `job-${String(this.nextJobId++)}`;
	}

	/** ジョブを開始する。既存ジョブがあれば自動キャンセルする。 */
	startJob(
		type: Exclude<ActionState["type"], "idle">,
		target: string,
		executor: JobExecutor,
	): string {
		this.ensureJobNotCoolingDown(type);
		// 既存ジョブを自動キャンセル
		if (this.currentJob) {
			this.cancelCurrentJob("superseded");
		}

		const id = this.generateJobId();
		const abortController = new AbortController();
		const info: JobInfo = {
			id,
			type,
			target,
			status: "running",
			startedAt: new Date(),
		};

		this.currentJob = { info, abortController };
		this.setActionState({ type, target, jobId: id });

		// バックグラウンドで executor を実行
		const run = async (): Promise<void> => {
			try {
				await executor(abortController.signal, (progress: string) => {
					if (this.currentJob?.info.id === id) {
						this.setActionState({ type, target, jobId: id, progress });
					}
				});
				this.finishJob(id, "completed");
			} catch (err) {
				if (abortController.signal.aborted) {
					// キャンセル済みなら finishJob はすでに呼ばれている
					return;
				}
				const msg = err instanceof Error ? err.message : String(err);
				this.finishJob(id, "failed", msg);
			}
		};

		void run();
		return id;
	}

	/** 現在のジョブをキャンセルする */
	cancelCurrentJob(_reason: CancellationReason = "manual"): boolean {
		if (!this.currentJob) return false;
		const { info, abortController } = this.currentJob;
		abortController.abort();
		this.finishJob(info.id, "cancelled");
		return true;
	}

	/** 現在実行中のジョブ情報を返す */
	getCurrentJob(): JobInfo | null {
		return this.currentJob?.info ?? null;
	}

	/** 直近のジョブ履歴を返す */
	getRecentJobs(limit: number = 5): JobInfo[] {
		return this.recentJobs.slice(-limit);
	}

	getCooldowns(): CooldownInfo[] {
		const now = Date.now();
		for (const [type, until] of this.cooldowns.entries()) {
			if (until.getTime() <= now) this.cooldowns.delete(type);
		}
		return [...this.cooldowns.entries()]
			.toSorted((a, b) => a[1].getTime() - b[1].getTime())
			.map(([type, until]) => ({ type, until }));
	}

	private ensureJobNotCoolingDown(type: Exclude<ActionState["type"], "idle">): void {
		const until = this.cooldowns.get(type);
		if (!until) return;
		const remainingMs = until.getTime() - Date.now();
		if (remainingMs <= 0) {
			this.cooldowns.delete(type);
			this.failureStreaks.delete(type);
			return;
		}
		const seconds = Math.ceil(remainingMs / 1000);
		throw new Error(`${type} はクールダウン中です（残り ${String(seconds)} 秒）`);
	}

	private finishJob(jobId: string, status: JobStatus, error?: string): void {
		if (this.currentJob?.info.id !== jobId) return;

		const { info } = this.currentJob;
		info.status = status;
		info.finishedAt = new Date();
		if (error) {
			info.error = status === "failed" ? `${classifyFailure(error)}: ${error}` : error;
		}

		this.recentJobs.push({ ...info });
		if (this.recentJobs.length > MAX_RECENT_JOBS) this.recentJobs.shift();

		this.currentJob = null;
		this.setActionState({ type: "idle" });

		this.metrics?.incrementCounter(METRIC.MC_JOBS, { type: info.type, status });
		this.updateCooldownState(info.type, status);

		if (status === "completed") {
			this.stuckNotified = false;
		}

		const description = this.formatFinishDescription(info);
		const importance: Importance = status === "cancelled" ? "low" : "medium";
		this.pushEvent("job", description, importance);

		if (status === "failed" && !this.stuckNotified) {
			const result = this.isStuck();
			if (result.stuck) {
				this.stuckNotified = true;
				this.metrics?.incrementCounter(METRIC.MC_STUCK, {});
				this.pushEvent("stuck", result.reason ?? "", "high");
			}
		}
	}

	private updateCooldownState(type: Exclude<ActionState["type"], "idle">, status: JobStatus): void {
		if (status === "completed") {
			this.failureStreaks.delete(type);
			this.cooldowns.delete(type);
			return;
		}
		if (status === "cancelled") {
			this.failureStreaks.delete(type);
			return;
		}
		if (status !== "failed") return;

		const streak = (this.failureStreaks.get(type) ?? 0) + 1;
		this.failureStreaks.set(type, streak);
		this.metrics?.incrementCounter(METRIC.MC_FAILURE_STREAKS, { type });
		if (streak < FAILURE_STREAK_FOR_COOLDOWN) return;

		const until = new Date(Date.now() + this.cooldownMs);
		this.cooldowns.set(type, until);
		this.metrics?.incrementCounter(METRIC.MC_COOLDOWNS, { type });
		this.pushEvent(
			"job",
			`クールダウン開始: ${type} を ${String(Math.ceil(this.cooldownMs / 1000))} 秒停止`,
			"medium",
		);
	}

	private formatFinishDescription(info: JobInfo): string {
		switch (info.status) {
			case "completed":
				return `ジョブ完了: ${info.type} → ${info.target}`;
			case "failed":
				return `ジョブ失敗: ${info.type} → ${info.target} (${info.error ?? "不明なエラー"})`;
			case "cancelled":
				return `ジョブキャンセル: ${info.type} → ${info.target}`;
			default:
				return `ジョブ終了: ${info.type} → ${info.target}`;
		}
	}

	/** スタック通知フラグをリセットする（復帰成功時に外部から呼ばれる） */
	resetStuckNotification(): void {
		this.stuckNotified = false;
	}

	/** 位置スナップショットを記録する（リングバッファ） */
	recordPositionSnapshot(pos: { x: number; y: number; z: number }): void {
		this.positionSnapshots.push({ x: pos.x, y: pos.y, z: pos.z });
		if (this.positionSnapshots.length > MAX_POSITION_SNAPSHOTS) {
			this.positionSnapshots.shift();
		}
	}

	/** stuck 状態かどうかを判定する */
	isStuck(): { stuck: boolean; reason?: string } {
		const now = Date.now();

		// C: 時間条件 — 最後の成功ジョブから stuckTimeMsThreshold 以上経過
		const lastSuccess = this.recentJobs.findLast((j) => j.status === "completed");
		const lastSuccessAt = lastSuccess?.finishedAt?.getTime() ?? 0;
		const timeSinceSuccess = now - lastSuccessAt;
		if (timeSinceSuccess < this.stuckTimeMsThreshold) {
			return { stuck: false };
		}

		// A: 連続失敗 — 直近 N 件のジョブがすべて同一タイプで failed
		const recentN = this.recentJobs.slice(-this.stuckFailureThreshold);
		const firstType = recentN.at(0)?.type;
		const allFailed =
			recentN.length >= this.stuckFailureThreshold &&
			recentN.every((j) => j.status === "failed" && j.type === firstType);
		if (allFailed) {
			const mins = String(Math.round(timeSinceSuccess / 60_000));
			return {
				stuck: true,
				reason: `直近 ${String(this.stuckFailureThreshold)} 件のジョブがすべて失敗。最後の成功から ${mins} 分経過`,
			};
		}

		// B: 位置停滞 — 過去 3 回のスナップショットの総移動距離 < threshold、かつ idle
		if (this.currentJob === null && this.positionSnapshots.length >= 3) {
			const distance = totalTravelDistance(this.positionSnapshots.slice(-3));
			if (distance < this.stuckPositionThreshold) {
				const mins = String(Math.round(timeSinceSuccess / 60_000));
				return {
					stuck: true,
					reason: `位置停滞: 総移動距離 ${String(Math.round(distance * 10) / 10)} ブロック（閾値 ${String(this.stuckPositionThreshold)}）。最後の成功から ${mins} 分経過`,
				};
			}
		}

		return { stuck: false };
	}
}
