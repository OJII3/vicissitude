import { buildAgentMetricLabels, METRIC } from "@vicissitude/observability/metrics";
import type { MetricsCollector } from "@vicissitude/shared/types";

interface ActivePromptMetrics {
	labels: Record<string, string>;
	startedAt: number;
}

export type PromptOutcome = "success" | "error" | "cancelled" | "deleted";

export interface PromptMetricsConfig {
	metrics?: MetricsCollector;
	agentId: string;
	contextScopeId?: string;
	model: { providerId: string; modelId: string };
}

/**
 * AgentRunner のプロンプト lifecycle メトリクスとラベル構築を担う。
 * AgentRunner からは観察されないため、排出メトリクスの名前・ラベル・回数を
 * 旧 AgentRunner 実装と完全一致させること。
 */
export class PromptMetricsTracker {
	private active: ActivePromptMetrics | null = null;
	private lastLabels: Record<string, string> | null = null;
	private readonly metrics?: MetricsCollector;
	private readonly agentId: string;
	private readonly contextScopeId?: string;
	private readonly model: { providerId: string; modelId: string };

	constructor(config: PromptMetricsConfig) {
		this.metrics = config.metrics;
		this.agentId = config.agentId;
		this.contextScopeId = config.contextScopeId;
		this.model = config.model;
	}

	buildLabels(options: { trigger?: string; scopeId?: string } = {}): Record<string, string> {
		return buildAgentMetricLabels({
			agentId: this.agentId,
			scopeId: options.scopeId ?? this.contextScopeId,
			trigger: options.trigger ?? "session",
			providerId: this.model.providerId,
			modelId: this.model.modelId,
		});
	}

	labels(extra: Record<string, string> = {}): Record<string, string> {
		return {
			...(this.active?.labels ?? this.lastLabels ?? this.buildLabels()),
			...extra,
		};
	}

	/** プロンプト送信直前に次ターンのラベルをフォールバック用に予約する */
	setPendingLabels(trigger: string, scopeId: string | undefined): void {
		this.lastLabels = this.buildLabels({ trigger, scopeId });
	}

	start(trigger: string, scopeId: string | undefined): void {
		const labels = this.buildLabels({ trigger, scopeId });
		this.active = { labels, startedAt: performance.now() };
		this.lastLabels = null;
		this.metrics?.incrementGauge(METRIC.LLM_BUSY_SESSIONS, labels);
	}

	finalize(outcome: PromptOutcome): void {
		const active = this.active;
		if (!active) return;
		this.lastLabels = active.labels;
		if (this.metrics) {
			const labels = { ...active.labels, outcome };
			const duration = (performance.now() - active.startedAt) / 1000;
			this.metrics.incrementCounter(METRIC.AI_REQUESTS, labels);
			this.metrics.observeHistogram(METRIC.AI_REQUEST_DURATION, duration, labels);
			this.metrics.decrementGauge(METRIC.LLM_BUSY_SESSIONS, active.labels);
		}
		this.active = null;
	}
}
