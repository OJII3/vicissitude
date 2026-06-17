import { describe, expect, mock, test } from "bun:test";

import { PromptMetricsTracker } from "./runner-prompt-metrics.ts";

function createMetrics() {
	return {
		incrementCounter: mock(() => {}),
		addCounter: mock(() => {}),
		setGauge: mock(() => {}),
		incrementGauge: mock(() => {}),
		decrementGauge: mock(() => {}),
		observeHistogram: mock(() => {}),
	};
}

const config = {
	agentId: "guild-1",
	contextScopeId: "scope-1",
	model: { providerId: "p", modelId: "m" },
};

describe("PromptMetricsTracker", () => {
	test("buildLabels は agentId/trigger を含む", () => {
		const tracker = new PromptMetricsTracker(config);
		const labels = tracker.buildLabels({ trigger: "user", scopeId: "s2" });
		expect(labels).toMatchObject({ agent_id: "guild-1", trigger: "user" });
	});

	test("labels は active → pending → buildLabels の順でフォールバックする", () => {
		const tracker = new PromptMetricsTracker(config);
		expect(tracker.labels().trigger).toBe("session");
		tracker.setPendingLabels("user", "s2");
		expect(tracker.labels().trigger).toBe("user");
		tracker.start("internal", "s3");
		expect(tracker.labels().trigger).toBe("internal");
	});

	test("start は LLM_BUSY_SESSIONS をインクリメントする", () => {
		const metrics = createMetrics();
		const tracker = new PromptMetricsTracker({ ...config, metrics });
		tracker.start("user", "s2");
		expect(metrics.incrementGauge).toHaveBeenCalledTimes(1);
	});

	test("finalize は AI_REQUESTS/AI_REQUEST_DURATION を記録し LLM_BUSY_SESSIONS をデクリメントする", () => {
		const metrics = createMetrics();
		const tracker = new PromptMetricsTracker({ ...config, metrics });
		tracker.start("user", "s2");
		tracker.finalize("success");
		expect(metrics.incrementCounter).toHaveBeenCalledTimes(1);
		expect(metrics.observeHistogram).toHaveBeenCalledTimes(1);
		expect(metrics.decrementGauge).toHaveBeenCalledTimes(1);
		const counterCall = metrics.incrementCounter.mock.calls[0] as unknown[];
		expect(counterCall?.[1]).toMatchObject({ outcome: "success" });
	});

	test("active が無いとき finalize は何もしない", () => {
		const metrics = createMetrics();
		const tracker = new PromptMetricsTracker({ ...config, metrics });
		tracker.finalize("error");
		expect(metrics.incrementCounter).toHaveBeenCalledTimes(0);
	});
});
