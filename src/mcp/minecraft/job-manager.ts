import { METRIC } from "../../core/constants.ts";
import type { MetricsCollector } from "../../core/types.ts";
import type { ActionState, Importance, JobInfo, JobStatus } from "./helpers.ts";

type PushEvent = (kind: string, description: string, importance: Importance) => void;
type SetActionState = (state: ActionState) => void;

export type JobExecutor = (
	signal: AbortSignal,
	updateProgress: (progress: string) => void,
) => Promise<void>;

const MAX_RECENT_JOBS = 20;

export class JobManager {
	private currentJob: {
		info: JobInfo;
		abortController: AbortController;
	} | null = null;
	private recentJobs: JobInfo[] = [];
	private nextJobId = 1;
	private readonly pushEvent: PushEvent;
	private readonly setActionState: SetActionState;
	private readonly metrics?: MetricsCollector;

	constructor(pushEvent: PushEvent, setActionState: SetActionState, metrics?: MetricsCollector) {
		this.pushEvent = pushEvent;
		this.setActionState = setActionState;
		this.metrics = metrics;
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

	private finishJob(jobId: string, status: JobStatus, error?: string): void {
		if (this.currentJob?.info.id !== jobId) return;

		const { info } = this.currentJob;
		info.status = status;
		info.finishedAt = new Date();
		if (error) info.error = error;

		this.recentJobs.push({ ...info });
		if (this.recentJobs.length > MAX_RECENT_JOBS) this.recentJobs.shift();

		this.currentJob = null;
		this.setActionState({ type: "idle" });

		this.metrics?.incrementCounter(METRIC.MC_JOBS, { type: info.type, status });

		const description = this.formatFinishDescription(info);
		const importance: Importance = status === "cancelled" ? "low" : "medium";
		this.pushEvent("job", description, importance);
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
