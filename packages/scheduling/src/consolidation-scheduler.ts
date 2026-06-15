import { METRIC } from "@vicissitude/observability/metrics";
import { defaultSubject, namespaceKey } from "@vicissitude/shared/namespace";
import type {
	CriticAuditSkipReason,
	CriticAuditorPort,
	GitHubIssuePort,
} from "@vicissitude/shared/ports";
import type { Logger, MemoryConsolidator, MetricsCollector } from "@vicissitude/shared/types";

import { type PeriodicTickConfig, PeriodicTickScheduler } from "./periodic-tick-scheduler.ts";

/** 30 minutes */
const CONSOLIDATION_TICK_INTERVAL_MS = 30 * 60_000;
/** 10 minutes (LLM calls are slow) */
const CONSOLIDATION_TICK_TIMEOUT_MS = 10 * 60_000;
/** 5 minutes delay before first tick */
const CONSOLIDATION_INITIAL_DELAY_MS = 5 * 60_000;

const tickConfig: PeriodicTickConfig = {
	logPrefix: "[memory-consolidation]",
	tickTimeoutMs: CONSOLIDATION_TICK_TIMEOUT_MS,
	timeoutMessage: "memory consolidation tick timed out",
	tickCounterMetric: METRIC.MEMORY_CONSOLIDATION_TICKS,
	tickDurationMetric: METRIC.MEMORY_CONSOLIDATION_TICK_DURATION,
};

export interface ConsolidationSchedulerDeps {
	consolidator: MemoryConsolidator;
	logger: Logger;
	metrics?: MetricsCollector;
	criticAuditor?: CriticAuditorPort;
	issueReporter?: GitHubIssuePort;
}

export class ConsolidationScheduler extends PeriodicTickScheduler {
	private timer: ReturnType<typeof setInterval> | null = null;
	private initialTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly consolidator: MemoryConsolidator;
	private readonly criticAuditor?: CriticAuditorPort;
	private readonly issueReporter?: GitHubIssuePort;
	private readonly lastCriticAuditSkipReasons = new Map<string, CriticAuditSkipReason>();

	constructor(deps: ConsolidationSchedulerDeps) {
		super(tickConfig, deps.logger, deps.metrics);
		this.consolidator = deps.consolidator;
		this.criticAuditor = deps.criticAuditor;
		this.issueReporter = deps.issueReporter;
	}

	start(): void {
		if (this.timer || this.initialTimer) return;
		this.logger.info(
			"[memory-consolidation] scheduler started (30min interval, first tick in 5min)",
		);
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
		this.logger.info("[memory-consolidation] scheduler stopped");
	}

	/** Inlined ConsolidateMemoryUseCase.execute */
	protected async runTick(): Promise<void> {
		const namespaces = this.consolidator.getActiveNamespaces();
		if (namespaces.length === 0) {
			this.logger.info("[memory-consolidation] no active namespaces, skipping");
			return;
		}

		for (const namespace of namespaces) {
			const key = namespaceKey(namespace);
			try {
				/* oxlint-disable-next-line no-await-in-loop -- sequential: avoid DB write contention across namespaces */
				const result = await this.consolidator.consolidate(namespace);
				if (result.processedEpisodes > 0) {
					this.logger.info(
						`[memory-consolidation] ns=${key}: ${String(result.processedEpisodes)} episodes processed, new=${String(result.newFacts)} reinforce=${String(result.reinforced)} update=${String(result.updated)} invalidate=${String(result.invalidated)}`,
					);
				}
				/* oxlint-disable-next-line no-await-in-loop -- sequential: critic audit after consolidation */
				await this.runCriticAudit(namespace, key);
			} catch (err) {
				this.logger.error(`[memory-consolidation] ns=${key} failed:`, err);
			}
		}
	}

	private async runCriticAudit(
		namespace: Parameters<typeof defaultSubject>[0],
		key: string,
	): Promise<void> {
		if (!this.criticAuditor) return;
		try {
			const subject = defaultSubject(namespace);
			const result = await this.criticAuditor.audit(subject);
			if (result.status === "skipped") {
				this.metrics?.incrementCounter(METRIC.CRITIC_AUDITOR_SKIP_TOTAL, {
					namespace: key,
					reason: result.reason,
				});
				if (result.driftScore !== undefined) {
					this.metrics?.setGauge(METRIC.DRIFT_SCORE, result.driftScore, { namespace: key });
				}
				const previousReason = this.lastCriticAuditSkipReasons.get(key);
				this.lastCriticAuditSkipReasons.set(key, result.reason);
				if (result.reason === "low_drift" || previousReason === result.reason) return;
				this.logger.warn(`[critic-audit] ns=${key}: skipped (${result.reason})`);
				return;
			}

			if (result.status === "completed") {
				this.lastCriticAuditSkipReasons.delete(key);
				this.metrics?.incrementCounter(METRIC.DRIFT_AUDITS, {
					namespace: key,
					severity: result.severity,
				});
				if (result.driftScore !== undefined) {
					this.metrics?.setGauge(METRIC.DRIFT_SCORE, result.driftScore, { namespace: key });
				}
				if (result.severity === "major") {
					this.logger.warn(`[critic-audit] ns=${key}: MAJOR drift detected — ${result.summary}`);
					await this.reportIssueIfNeeded(result);
				}
			}
		} catch (err) {
			this.logger.error(`[critic-audit] ns=${key} failed:`, err);
		}
	}

	private async reportIssueIfNeeded(result: {
		severity: string;
		summary: string;
		issueTitle?: string;
		issueBody?: string;
	}): Promise<void> {
		if (!result.issueTitle || !result.issueBody) return;
		if (!this.issueReporter) return;

		try {
			const sinceDateISO = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
			const recentIssues = await this.issueReporter.findRecentIssues({
				label: "character-drift",
				sinceDateISO,
			});

			if (recentIssues.some((issue: { title: string }) => issue.title === result.issueTitle)) {
				this.logger.info(
					`[critic-audit] skip issue creation: duplicate title "${result.issueTitle}"`,
				);
				return;
			}

			const created = await this.issueReporter.createIssue({
				title: result.issueTitle,
				body: result.issueBody,
				labels: ["character-drift"],
			});
			this.logger.info(`[critic-audit] issue created: ${created.url}`);
		} catch (err) {
			this.logger.error("[critic-audit] failed to create issue:", err);
		}
	}
}
