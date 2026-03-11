import { METRIC } from "../../core/constants.ts";
import type { MetricsCollector } from "../../core/types.ts";
import type { ActionState, Importance, JobInfo, JobStatus } from "./helpers.ts";

type PushEvent = (kind: string, description: string, importance: Importance) => void;
type SetActionState = (state: ActionState) => void;

interface CooldownInfo {
	type: Exclude<ActionState["type"], "idle">;
	until: Date;
}

interface JobManagerOptions {
	cooldownMs?: number;
}

export type JobExecutor = (
	signal: AbortSignal,
	updateProgress: (progress: string) => void,
) => Promise<void>;

const MAX_RECENT_JOBS = 20;
const DEFAULT_COOLDOWN_MS = 60_000;
const FAILURE_STREAK_FOR_COOLDOWN = 2;

function classifyFailure(error?: string): string {
	if (!error) return "unknown failure";
	const normalized = error.toLowerCase();
	if (
		normalized.includes("path") ||
		normalized.includes("到達") ||
		normalized.includes("goal") ||
		normalized.includes("見つからない")
	) {
		return "pathfinding failure";
	}
	if (
		normalized.includes("材料") ||
		normalized.includes("recipe") ||
		normalized.includes("食料") ||
		normalized.includes("作業台")
	) {
		return "resource shortage";
	}
	if (
		normalized.includes("見つかりません") ||
		normalized.includes("なくな") ||
		normalized.includes("離脱")
	) {
		return "target missing";
	}
	if (
		normalized.includes("disconnect") ||
		normalized.includes("接続") ||
		normalized.includes("kicked")
	) {
		return "connection failure";
	}
	return "survival failure";
}

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
			this.cancelCurrentJob();
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
	cancelCurrentJob(): boolean {
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
			info.error =
				status === "failed" ? `${classifyFailure(error)}: ${error}` : error;
		}

		this.recentJobs.push({ ...info });
		if (this.recentJobs.length > MAX_RECENT_JOBS) this.recentJobs.shift();

		this.currentJob = null;
		this.setActionState({ type: "idle" });

		this.metrics?.incrementCounter(METRIC.MC_JOBS, { type: info.type, status });
		this.updateCooldownState(info.type, status);

		const description = this.formatFinishDescription(info);
		const importance: Importance = status === "cancelled" ? "low" : "medium";
		this.pushEvent("job", description, importance);
	}

	private updateCooldownState(type: Exclude<ActionState["type"], "idle">, status: JobStatus): void {
		if (status === "completed") {
			this.failureStreaks.delete(type);
			this.cooldowns.delete(type);
			return;
		}
		if (status !== "failed" && status !== "cancelled") return;

		const streak = (this.failureStreaks.get(type) ?? 0) + 1;
		this.failureStreaks.set(type, streak);
		if (streak < FAILURE_STREAK_FOR_COOLDOWN) return;

		const until = new Date(Date.now() + this.cooldownMs);
		this.cooldowns.set(type, until);
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
}
