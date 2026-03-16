import { delayResolve, withTimeout } from "@vicissitude/shared/functions";
import type { Logger, MemoryConsolidator, MetricsCollector } from "@vicissitude/shared/types";
import { METRIC } from "@vicissitude/observability/metrics";

/** 30 minutes */
const CONSOLIDATION_TICK_INTERVAL_MS = 30 * 60_000;
/** 10 minutes (LLM calls are slow) */
const CONSOLIDATION_TICK_TIMEOUT_MS = 10 * 60_000;
/** 5 minutes delay before first tick */
const CONSOLIDATION_INITIAL_DELAY_MS = 5 * 60_000;

export class ConsolidationScheduler {
	private timer: ReturnType<typeof setInterval> | null = null;
	private initialTimer: ReturnType<typeof setTimeout> | null = null;
	private running = false;
	private executePromise: Promise<void> | null = null;

	constructor(
		private readonly consolidator: MemoryConsolidator,
		private readonly logger: Logger,
		private readonly metrics?: MetricsCollector,
	) {}

	start(): void {
		if (this.timer || this.initialTimer) return;
		this.logger.info("[ltm-consolidation] スケジューラ開始（30分間隔、初回5分後）");
		this.initialTimer = setTimeout(() => {
			this.initialTimer = null;
			void this.tick();
			this.timer = setInterval(() => void this.tick(), CONSOLIDATION_TICK_INTERVAL_MS);
		}, CONSOLIDATION_INITIAL_DELAY_MS);
	}

	async stop(): Promise<void> {
		if (this.initialTimer) {
			clearTimeout(this.initialTimer);
			this.initialTimer = null;
		}
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		if (this.executePromise) {
			await this.executePromise.catch(() => {});
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
		const execution = this.executeConsolidation();
		this.executePromise = execution;
		try {
			await withTimeout(
				execution,
				CONSOLIDATION_TICK_TIMEOUT_MS,
				"ltm consolidation tick timed out",
			);
			this.metrics?.incrementCounter(METRIC.LTM_CONSOLIDATION_TICKS, { outcome: "success" });
		} catch (error) {
			this.metrics?.incrementCounter(METRIC.LTM_CONSOLIDATION_TICKS, { outcome: "error" });
			this.logger.error("[ltm-consolidation] tick エラー:", error);
		} finally {
			const duration = (performance.now() - start) / 1000;
			this.metrics?.observeHistogram(METRIC.LTM_CONSOLIDATION_TICK_DURATION, duration);
		}

		// Wait for execution to complete, but cap to prevent deadlock
		const settled = await Promise.race([
			execution.then(() => true).catch(() => true),
			delayResolve(CONSOLIDATION_TICK_TIMEOUT_MS, false as const),
		]);
		if (!settled) {
			this.logger.error(
				"[ltm-consolidation] execution did not settle after force timeout, resetting running flag",
			);
		}
		this.executePromise = null;
		this.running = false;
	}

	/** Inlined ConsolidateMemoryUseCase.execute */
	private async executeConsolidation(): Promise<void> {
		const guildIds = this.consolidator.getActiveGuildIds();
		if (guildIds.length === 0) {
			this.logger.info("[ltm-consolidation] アクティブなギルドなし、スキップ");
			return;
		}

		for (const guildId of guildIds) {
			try {
				/* oxlint-disable-next-line no-await-in-loop -- sequential: avoid DB write contention across guilds */
				const result = await this.consolidator.consolidate(guildId);
				if (result.processedEpisodes > 0) {
					this.logger.info(
						`[ltm-consolidation] guild=${guildId}: ${String(result.processedEpisodes)} episodes processed, new=${String(result.newFacts)} reinforce=${String(result.reinforced)} update=${String(result.updated)} invalidate=${String(result.invalidated)}`,
					);
				}
			} catch (err) {
				this.logger.error(`[ltm-consolidation] guild=${guildId} failed:`, err);
			}
		}
	}
}
