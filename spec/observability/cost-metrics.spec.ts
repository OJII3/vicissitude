import { describe, expect, it } from "bun:test";

import {
	PrometheusCollector,
	METRIC,
	recordTokenMetrics,
} from "@vicissitude/observability/metrics";

const LLM_COST_METRIC = "llm_cost_dollars_total";

function createSetup() {
	const collector = new PrometheusCollector();
	collector.registerCounter(METRIC.AI_REQUESTS, "AI requests");
	collector.registerGauge(METRIC.LLM_BUSY_SESSIONS, "Busy sessions");
	collector.registerHistogram(METRIC.AI_REQUEST_DURATION, "Duration", [1, 5]);
	collector.registerCounter(METRIC.LLM_INPUT_TOKENS, "Input tokens");
	collector.registerCounter(METRIC.LLM_OUTPUT_TOKENS, "Output tokens");
	collector.registerCounter(METRIC.LLM_CACHE_READ_TOKENS, "Cache read tokens");
	collector.registerCounter(LLM_COST_METRIC, "LLM cost in USD");
	collector.registerCounter(METRIC.LLM_PRICING_UNKNOWN, "Unknown LLM pricing");
	return collector;
}

describe("recordTokenMetrics とコストメトリクス", () => {
	it("modelId を渡すと llm_cost_dollars_total カウンターが記録される", () => {
		const collector = createSetup();
		const tokens = { input: 1000, output: 500, cacheRead: 200 };
		const labels = {
			agent_kind: "discord",
			agent_id: "discord:111111111111111111",
			scope_id: "discord:guild:111111111111111111",
			trigger: "home",
			provider: "openai",
			model: "gpt-4o",
		};

		recordTokenMetrics(collector, tokens, labels, "gpt-4o");

		const output = collector.serialize();
		expect(output).toContain("llm_cost_dollars_total{");
		// model ラベルが含まれること
		expect(output).toContain('model="gpt-4o"');
	});

	it("modelId を渡さない場合はコストメトリクスが記録されない", () => {
		const collector = createSetup();
		const tokens = { input: 1000, output: 500, cacheRead: 200 };
		const labels = {
			agent_kind: "discord",
			agent_id: "discord:111111111111111111",
			scope_id: "discord:guild:111111111111111111",
			trigger: "home",
			provider: "openai",
			model: "gpt-4o",
		};

		recordTokenMetrics(collector, tokens, labels);

		const output = collector.serialize();
		expect(output).not.toContain("llm_cost_dollars_total{");
	});

	it("未知のモデルID の場合は未知 pricing カウンターに記録される", () => {
		const collector = createSetup();
		const tokens = { input: 1000, output: 500, cacheRead: 200 };
		const labels = {
			agent_kind: "discord",
			agent_id: "discord:111111111111111111",
			scope_id: "discord:guild:111111111111111111",
			trigger: "home",
			provider: "openai",
			model: "unknown-model-xyz",
		};

		recordTokenMetrics(collector, tokens, labels, "unknown-model-xyz");

		const output = collector.serialize();
		expect(output).not.toContain("llm_cost_dollars_total{");
		expect(output).toContain("llm_pricing_unknown_total{");
		expect(output).toContain('model="unknown-model-xyz"');
	});
});
