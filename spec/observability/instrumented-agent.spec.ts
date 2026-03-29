import { describe, expect, it, mock } from "bun:test";

import {
	InstrumentedAiAgent,
	PrometheusCollector,
	METRIC,
} from "@vicissitude/observability/metrics";
import type { AgentResponse } from "@vicissitude/shared/types";

function createSetup() {
	const collector = new PrometheusCollector();
	collector.registerCounter(METRIC.AI_REQUESTS, "AI requests");
	collector.registerGauge(METRIC.LLM_BUSY_SESSIONS, "Busy sessions");
	collector.registerHistogram(METRIC.AI_REQUEST_DURATION, "Duration", [1, 5]);
	collector.registerCounter(METRIC.LLM_INPUT_TOKENS, "Input tokens");
	collector.registerCounter(METRIC.LLM_OUTPUT_TOKENS, "Output tokens");
	collector.registerCounter(METRIC.LLM_CACHE_READ_TOKENS, "Cache read tokens");
	return collector;
}

describe("InstrumentedAiAgent", () => {
	it("成功時に busy gauge が inc/dec される（リーク防止）", async () => {
		const collector = createSetup();
		const inner = {
			send: mock((): Promise<AgentResponse> => Promise.resolve({ text: "ok", sessionId: "s1" })),
			stop: mock(() => {}),
		};
		const agent = new InstrumentedAiAgent(inner, collector, "polling");

		await agent.send({ sessionKey: "discord:ch:user", message: "hi" });

		const output = collector.serialize();
		expect(output).toContain("llm_busy_sessions");
		expect(output).toContain('llm_busy_sessions{agent_type="polling"} 0');
	});

	it("成功時に counter が outcome=success でインクリメントされる", async () => {
		const collector = createSetup();
		const inner = {
			send: mock((): Promise<AgentResponse> => Promise.resolve({ text: "ok", sessionId: "s1" })),
			stop: mock(() => {}),
		};
		const agent = new InstrumentedAiAgent(inner, collector, "polling");

		await agent.send({ sessionKey: "discord:ch:_channel", message: "hi" });

		const output = collector.serialize();
		expect(output).toContain(
			'ai_requests_total{agent_type="polling",outcome="success",trigger="home"} 1',
		);
	});

	it("エラー時に counter が outcome=error でインクリメントされる", () => {
		const collector = createSetup();
		const inner = {
			send: mock((): Promise<AgentResponse> => Promise.reject(new Error("fail"))),
			stop: mock(() => {}),
		};
		const agent = new InstrumentedAiAgent(inner, collector, "polling");

		expect(agent.send({ sessionKey: "system:heartbeat:g1", message: "hi" })).rejects.toThrow(
			"fail",
		);

		const output = collector.serialize();
		expect(output).toContain(
			'ai_requests_total{agent_type="polling",outcome="error",trigger="heartbeat"} 1',
		);
	});

	it("エラー時でも busy gauge が dec される", async () => {
		const collector = createSetup();
		const inner = {
			send: mock((): Promise<AgentResponse> => Promise.reject(new Error("fail"))),
			stop: mock(() => {}),
		};
		const agent = new InstrumentedAiAgent(inner, collector, "polling");

		await agent.send({ sessionKey: "discord:ch:user", message: "hi" }).catch(() => {});

		const output = collector.serialize();
		expect(output).toContain('llm_busy_sessions{agent_type="polling"} 0');
	});

	it("histogram に duration が記録される", async () => {
		const collector = createSetup();
		const inner = {
			send: mock((): Promise<AgentResponse> => Promise.resolve({ text: "ok", sessionId: "s1" })),
			stop: mock(() => {}),
		};
		const agent = new InstrumentedAiAgent(inner, collector, "polling");

		await agent.send({ sessionKey: "discord:ch:user", message: "hi" });

		const output = collector.serialize();
		expect(output).toContain("ai_request_duration_seconds_count 1");
	});

	it("成功時にトークンメトリクスが記録される", async () => {
		const collector = createSetup();
		const inner = {
			send: mock(
				(): Promise<AgentResponse> =>
					Promise.resolve({
						text: "ok",
						sessionId: "s1",
						tokens: { input: 150, output: 80, cacheRead: 50 },
					}),
			),
			stop: mock(() => {}),
		};
		const agent = new InstrumentedAiAgent(inner, collector, "polling");

		await agent.send({ sessionKey: "discord:ch:_channel", message: "hi" });

		const output = collector.serialize();
		expect(output).toContain('llm_input_tokens_total{agent_type="polling",trigger="home"} 150');
		expect(output).toContain('llm_output_tokens_total{agent_type="polling",trigger="home"} 80');
		expect(output).toContain('llm_cache_read_tokens_total{agent_type="polling",trigger="home"} 50');
	});

	it("トークン情報がない場合はトークンメトリクスのデータ行が記録されない", async () => {
		const collector = createSetup();
		const inner = {
			send: mock((): Promise<AgentResponse> => Promise.resolve({ text: "ok", sessionId: "s1" })),
			stop: mock(() => {}),
		};
		const agent = new InstrumentedAiAgent(inner, collector, "polling");

		await agent.send({ sessionKey: "discord:ch:user", message: "hi" });

		const output = collector.serialize();
		expect(output).not.toContain("llm_input_tokens_total{");
		expect(output).not.toContain("llm_output_tokens_total{");
	});

	it("stop() が inner に伝播する", () => {
		const collector = createSetup();
		const inner = {
			send: mock((): Promise<AgentResponse> => Promise.resolve({ text: "", sessionId: "" })),
			stop: mock(() => {}),
		};
		const agent = new InstrumentedAiAgent(inner, collector, "polling");

		agent.stop();

		expect(inner.stop).toHaveBeenCalledTimes(1);
	});
});
