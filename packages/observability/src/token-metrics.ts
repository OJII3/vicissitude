import type { MetricsCollector, TokenUsage } from "@vicissitude/shared/types";

import { METRIC } from "./metric-names.ts";
import { calculateCost, getModelPricing } from "./model-pricing.ts";

// ─── Token Metrics Helper ───────────────────────────────────────

export function recordTokenMetrics(
	metrics: MetricsCollector,
	tokens: TokenUsage,
	labels: Record<string, string>,
	modelId?: string,
): void {
	if (tokens.input > 0) metrics.addCounter(METRIC.LLM_INPUT_TOKENS, tokens.input, labels);
	if (tokens.output > 0) metrics.addCounter(METRIC.LLM_OUTPUT_TOKENS, tokens.output, labels);
	if (tokens.cacheRead > 0)
		metrics.addCounter(METRIC.LLM_CACHE_READ_TOKENS, tokens.cacheRead, labels);

	if (modelId) {
		const pricing = getModelPricing(modelId);
		if (pricing) {
			const cost = calculateCost(tokens, pricing);
			if (cost > 0) {
				metrics.addCounter(METRIC.LLM_COST_DOLLARS, cost, { ...labels, model: modelId });
			}
		} else {
			metrics.incrementCounter(METRIC.LLM_PRICING_UNKNOWN, { ...labels, model: modelId });
		}
	}
}
