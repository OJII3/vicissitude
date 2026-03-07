import { describe, expect, it } from "bun:test";

import type { AgentResponse } from "../../domain/entities/agent-response.ts";
import type { AiAgent, SendOptions } from "../../domain/ports/ai-agent.port.ts";
import type { MetricsCollector } from "../../domain/ports/metrics-collector.port.ts";
import { InstrumentedAiAgent, inferTrigger } from "./instrumented-ai-agent.ts";

describe("inferTrigger", () => {
	it('should return "heartbeat" for system:heartbeat: prefix', () => {
		expect(inferTrigger("system:heartbeat:_autonomous")).toBe("heartbeat");
		expect(inferTrigger("system:heartbeat:reminder-1")).toBe("heartbeat");
	});

	it('should return "home" for :_channel suffix', () => {
		expect(inferTrigger("discord:ch-123:_channel")).toBe("home");
		expect(inferTrigger("guild:456:_channel")).toBe("home");
	});

	it('should return "mention" for other patterns', () => {
		expect(inferTrigger("discord:ch-123:user-456")).toBe("mention");
		expect(inferTrigger("guild:789:thread-abc")).toBe("mention");
	});
});

function createMockAgent(response?: AgentResponse, error?: Error): AiAgent {
	return {
		send: () => {
			if (error) return Promise.reject(error);
			return Promise.resolve(response ?? { text: "ok", sessionId: "sess-1" });
		},
		stop: () => {},
	};
}

function createMockMetrics() {
	const calls: { method: string; name: string; value?: number; labels?: Record<string, string> }[] =
		[];
	const collector: MetricsCollector = {
		incrementCounter: (name, labels) => calls.push({ method: "incrementCounter", name, labels }),
		setGauge: (name, value, labels) => calls.push({ method: "setGauge", name, value, labels }),
		incrementGauge: (name, labels) => calls.push({ method: "incrementGauge", name, labels }),
		decrementGauge: (name, labels) => calls.push({ method: "decrementGauge", name, labels }),
		observeHistogram: (name, value, labels) =>
			calls.push({ method: "observeHistogram", name, value, labels }),
	};
	return { collector, calls };
}

const defaultOptions: SendOptions = {
	sessionKey: "discord:ch-123:user-456",
	message: "hello",
};

describe("InstrumentedAiAgent", () => {
	it("should increment and decrement busy gauge on success", async () => {
		const { collector, calls } = createMockMetrics();
		const agent = new InstrumentedAiAgent(createMockAgent(), collector, "polling");

		await agent.send(defaultOptions);

		const gaugeOps = calls.filter(
			(c) =>
				c.name === "llm_busy_sessions" &&
				(c.method === "incrementGauge" || c.method === "decrementGauge"),
		);
		expect(gaugeOps).toHaveLength(2);
		expect(gaugeOps.map((c) => c.method)).toEqual(["incrementGauge", "decrementGauge"]);
	});

	it("should decrement busy gauge even when inner agent throws", async () => {
		const { collector, calls } = createMockMetrics();
		const agent = new InstrumentedAiAgent(
			createMockAgent(undefined, new Error("LLM failure")),
			collector,
			"polling",
		);

		await expect(agent.send(defaultOptions)).rejects.toThrow("LLM failure");

		const gaugeOps = calls.filter(
			(c) =>
				c.name === "llm_busy_sessions" &&
				(c.method === "incrementGauge" || c.method === "decrementGauge"),
		);
		expect(gaugeOps).toHaveLength(2);
		expect(gaugeOps.map((c) => c.method)).toEqual(["incrementGauge", "decrementGauge"]);
	});

	it("should record success counter on success", async () => {
		const { collector, calls } = createMockMetrics();
		const agent = new InstrumentedAiAgent(createMockAgent(), collector, "polling");

		await agent.send(defaultOptions);

		const counterCall = calls.find(
			(c) => c.method === "incrementCounter" && c.name === "ai_requests_total",
		);
		expect(counterCall).toBeDefined();
		expect(counterCall?.labels).toEqual({
			agent_type: "polling",
			trigger: "mention",
			outcome: "success",
		});
	});

	it("should record error counter on failure", async () => {
		const { collector, calls } = createMockMetrics();
		const agent = new InstrumentedAiAgent(
			createMockAgent(undefined, new Error("fail")),
			collector,
			"polling",
		);

		await expect(agent.send(defaultOptions)).rejects.toThrow();

		const counterCall = calls.find(
			(c) => c.method === "incrementCounter" && c.name === "ai_requests_total",
		);
		expect(counterCall?.labels).toEqual({
			agent_type: "polling",
			trigger: "mention",
			outcome: "error",
		});
	});

	it("should observe histogram duration on both success and failure", async () => {
		const { collector, calls } = createMockMetrics();
		const agent = new InstrumentedAiAgent(createMockAgent(), collector, "polling");

		await agent.send(defaultOptions);

		const histCall = calls.find(
			(c) => c.method === "observeHistogram" && c.name === "ai_request_duration_seconds",
		);
		expect(histCall).toBeDefined();
		expect(histCall?.value).toBeGreaterThanOrEqual(0);
	});

	it("should pass agent_type label to busy gauge", async () => {
		const { collector, calls } = createMockMetrics();
		const agent = new InstrumentedAiAgent(createMockAgent(), collector, "polling");

		await agent.send(defaultOptions);

		const incCall = calls.find(
			(c) => c.method === "incrementGauge" && c.name === "llm_busy_sessions",
		);
		expect(incCall?.labels).toEqual({ agent_type: "polling" });
	});
});
