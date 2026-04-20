import { describe, expect, it, mock } from "bun:test";

import {
	InstrumentedAiAgent,
	PrometheusCollector,
	METRIC,
	recordTokenMetrics,
} from "@vicissitude/observability/metrics";
import type { AgentResponse } from "@vicissitude/shared/types";

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
	return collector;
}

describe("recordTokenMetrics とコストメトリクス", () => {
	it("modelId を渡すと llm_cost_dollars_total カウンターが記録される", () => {
		const collector = createSetup();
		const tokens = { input: 1000, output: 500, cacheRead: 200 };
		const labels = { agent_type: "polling", trigger: "home" };

		recordTokenMetrics(collector, tokens, labels, "gpt-4o");

		const output = collector.serialize();
		expect(output).toContain("llm_cost_dollars_total{");
		// model ラベルが含まれること
		expect(output).toContain('model="gpt-4o"');
	});

	it("modelId を渡さない場合はコストメトリクスが記録されない（後方互換性）", () => {
		const collector = createSetup();
		const tokens = { input: 1000, output: 500, cacheRead: 200 };
		const labels = { agent_type: "polling", trigger: "home" };

		recordTokenMetrics(collector, tokens, labels);

		const output = collector.serialize();
		expect(output).not.toContain("llm_cost_dollars_total{");
	});

	it("未知のモデルID の場合はコストメトリクスが記録されない", () => {
		const collector = createSetup();
		const tokens = { input: 1000, output: 500, cacheRead: 200 };
		const labels = { agent_type: "polling", trigger: "home" };

		recordTokenMetrics(collector, tokens, labels, "unknown-model-xyz");

		const output = collector.serialize();
		expect(output).not.toContain("llm_cost_dollars_total{");
	});
});

describe("InstrumentedAiAgent とコストメトリクス", () => {
	it("modelId を渡すと、成功時にコストメトリクスが記録される", async () => {
		const collector = createSetup();
		const inner = {
			send: mock(
				(): Promise<AgentResponse> =>
					Promise.resolve({
						text: "ok",
						sessionId: "s1",
						tokens: { input: 1000, output: 500, cacheRead: 200 },
					}),
			),
			stop: mock(() => {}),
		};
		const agent = new InstrumentedAiAgent(inner, collector, "polling", "gpt-4o");

		await agent.send({ sessionKey: "discord:ch:_channel", message: "hi" });

		const output = collector.serialize();
		expect(output).toContain("llm_cost_dollars_total{");
		expect(output).toContain('model="gpt-4o"');
	});

	it("modelId なしの InstrumentedAiAgent では成功時にもコストメトリクスが記録されない", async () => {
		const collector = createSetup();
		const inner = {
			send: mock(
				(): Promise<AgentResponse> =>
					Promise.resolve({
						text: "ok",
						sessionId: "s1",
						tokens: { input: 1000, output: 500, cacheRead: 200 },
					}),
			),
			stop: mock(() => {}),
		};
		const agent = new InstrumentedAiAgent(inner, collector, "polling");

		await agent.send({ sessionKey: "discord:ch:_channel", message: "hi" });

		const output = collector.serialize();
		expect(output).not.toContain("llm_cost_dollars_total{");
	});
});
