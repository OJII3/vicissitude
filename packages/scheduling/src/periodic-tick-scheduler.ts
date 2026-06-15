import { withTimeout } from "@vicissitude/shared/functions";
import type { Logger, MetricsCollector } from "@vicissitude/shared/types";

// ─── PeriodicTickScheduler ──────────────────────────────────────
//
// 周期 tick を駆動する scheduler の共通基底。
//
// 責務は「1 tick の重複実行ガード + タイムアウト + 計測 + 後始末」に限定する。
// - `running` フラグで前 tick 実行中の再入を防ぐ（再入時は skip ログのみ）。
// - `withTimeout` で 1 tick をガードし、タイムアウト後も実処理が継続中なら
//   settle するまで `running` を解放しない（= 次 tick を開始させない）。
// - tick の成否を counter に、所要時間を histogram に記録する。
//
// start/stop の timer 構成（即時 tick / 初回遅延 / dynamic interval /
// stop 時の in-flight 待機など）はサブクラスごとに異なるため基底に持たせない。
// サブクラスは start/stop を自前で実装し、その中から `tick()` を呼ぶ。

/** tick 計測・ログ用のメタ情報。サブクラスが固定値として供給する。 */
export interface PeriodicTickConfig {
	/** ログ prefix（例: "[heartbeat]"）。 */
	readonly logPrefix: string;
	/** 1 tick のタイムアウト（ms）。 */
	readonly tickTimeoutMs: number;
	/** タイムアウト時のエラーメッセージ。 */
	readonly timeoutMessage: string;
	/** tick の成否を記録する counter 名。 */
	readonly tickCounterMetric: string;
	/** 1 tick の所要時間（秒）を記録する histogram 名。 */
	readonly tickDurationMetric: string;
}

export abstract class PeriodicTickScheduler {
	private running = false;
	protected executePromise: Promise<void> | null = null;

	protected constructor(
		private readonly tickConfig: PeriodicTickConfig,
		protected readonly logger: Logger,
		protected readonly metrics: MetricsCollector | undefined,
	) {}

	/**
	 * 1 tick の実体。サブクラスが固有処理（due reminder 評価 / consolidation 等）を実装する。
	 * ここで投げられた例外は基底側の `withTimeout` で捕捉され error ログ + error counter になる。
	 */
	protected abstract runTick(): Promise<void>;

	/**
	 * 周期 tick の 1 回分。重複実行ガード・タイムアウト・計測・後始末を行う。
	 * 前 tick が実行中の場合は skip ログのみ出して即 return する。
	 */
	protected async tick(): Promise<void> {
		if (this.running) {
			this.logger.info(`${this.tickConfig.logPrefix} previous tick still running, skipping`);
			return;
		}

		this.running = true;
		const start = performance.now();
		const execution = this.runTick();
		this.executePromise = execution;
		let executionSettled = false;
		void execution.then(
			() => {
				executionSettled = true;
				return null;
			},
			() => {
				executionSettled = true;
				return null;
			},
		);
		try {
			await withTimeout(execution, this.tickConfig.tickTimeoutMs, this.tickConfig.timeoutMessage);
			this.metrics?.incrementCounter(this.tickConfig.tickCounterMetric, { outcome: "success" });
		} catch (error) {
			this.metrics?.incrementCounter(this.tickConfig.tickCounterMetric, { outcome: "error" });
			this.logger.error(`${this.tickConfig.logPrefix} tick error:`, error);
		} finally {
			const duration = (performance.now() - start) / 1000;
			this.metrics?.observeHistogram(this.tickConfig.tickDurationMetric, duration);
		}

		if (executionSettled) {
			this.releaseExecution(execution);
			return;
		}

		void this.releaseExecutionWhenSettled(execution);
	}

	private releaseExecution(execution: Promise<void>): void {
		if (this.executePromise !== execution) return;
		this.executePromise = null;
		this.running = false;
	}

	private async releaseExecutionWhenSettled(execution: Promise<void>): Promise<void> {
		await execution.catch(() => {});
		this.releaseExecution(execution);
	}
}
