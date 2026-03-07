import type { Executable } from "../../domain/ports/executable.port.ts";
import type { Logger } from "../../domain/ports/logger.port.ts";
import type { MetricsCollector } from "../../domain/ports/metrics-collector.port.ts";
import { withTimeout } from "../../domain/services/timeout.ts";
import { METRIC } from "../metrics/metric-names.ts";

/** 30 minutes */
const TICK_INTERVAL_MS = 30 * 60_000;
/** 10 minutes (LLM calls are slow) */
const TICK_TIMEOUT_MS = 10 * 60_000;
/** 5 minutes delay before first tick */
const INITIAL_DELAY_MS = 5 * 60_000;

export class IntervalConsolidationScheduler {
	private timer: ReturnType<typeof setInterval> | null = null;
	private initialTimer: ReturnType<typeof setTimeout> | null = null;
	private running = false;
	/**
	 * useCase.execute() の実 Promise を保持。
	 * withTimeout がタイムアウトしても、内部処理が完了するまで running を保持し、
	 * 次の tick との並走を防ぐ。
	 */
	private executePromise: Promise<void> | null = null;

	constructor(
		private readonly useCase: Executable,
		private readonly logger: Logger,
		private readonly metrics?: MetricsCollector,
	) {}

	start(): void {
		if (this.timer || this.initialTimer) return;

		this.logger.info("[ltm-consolidation] スケジューラ開始（30分間隔、初回5分後）");

		this.initialTimer = setTimeout(() => {
			this.initialTimer = null;
			void this.tick();
			this.timer = setInterval(() => void this.tick(), TICK_INTERVAL_MS);
		}, INITIAL_DELAY_MS);
	}

	stop(): void {
		if (this.initialTimer) {
			clearTimeout(this.initialTimer);
			this.initialTimer = null;
		}
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.logger.info("[ltm-consolidation] スケジューラ停止");
	}

	private async tick(): Promise<void> {
		if (this.running) {
			this.logger.info("[ltm-consolidation] 前回の実行がまだ進行中、スキップ");
			return;
		}

		this.running = true;
		const start = performance.now();
		const execution = this.useCase.execute();
		this.executePromise = execution;
		try {
			await withTimeout(execution, TICK_TIMEOUT_MS, "ltm consolidation tick timed out");
			this.metrics?.incrementCounter(METRIC.LTM_CONSOLIDATION_TICKS, { outcome: "success" });
		} catch (error) {
			this.metrics?.incrementCounter(METRIC.LTM_CONSOLIDATION_TICKS, { outcome: "error" });
			this.logger.error("[ltm-consolidation] tick エラー:", error);
		} finally {
			const duration = (performance.now() - start) / 1000;
			this.metrics?.observeHistogram(METRIC.LTM_CONSOLIDATION_TICK_DURATION, duration);
		}

		// タイムアウト後も内部処理が完了するまで running を保持し、次の tick との並走を防ぐ
		await execution.catch(() => {});
		this.executePromise = null;
		this.running = false;
	}
}
