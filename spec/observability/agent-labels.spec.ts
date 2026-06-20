import { describe, expect, test } from "bun:test";

import { buildAgentMetricLabels, inferAgentKind } from "@vicissitude/observability/metrics";

describe("inferAgentKind", () => {
	test("discord polling agentId", () => {
		expect(inferAgentKind("discord:111")).toBe("discord");
	});

	test("discord heartbeat agentId", () => {
		expect(inferAgentKind("discord:heartbeat:111")).toBe("discord_heartbeat");
	});

	test("緩い形式でも分類できる (strict モード非依存)", () => {
		expect(inferAgentKind("discord:guild-1")).toBe("discord");
		expect(inferAgentKind("discord:heartbeat:guild-1")).toBe("discord_heartbeat");
	});

	test("minecraft agentId", () => {
		expect(inferAgentKind("minecraft:brain")).toBe("minecraft");
	});

	test("web agentId", () => {
		expect(inferAgentKind("web:local")).toBe("web");
	});

	test("未知の agentId は unknown", () => {
		expect(inferAgentKind("foo:bar")).toBe("unknown");
		expect(inferAgentKind("")).toBe("unknown");
	});
});

describe("buildAgentMetricLabels", () => {
	test("parseAgentId 経由で scopeId を導出する", () => {
		const labels = buildAgentMetricLabels({
			agentId: "discord:111",
			providerId: "test-provider",
			modelId: "test-model",
		});
		expect(labels).toEqual({
			agent_kind: "discord",
			agent_id: "discord:111",
			scope_id: "discord:guild:111",
			trigger: "unknown",
			provider: "test-provider",
			model: "test-model",
		});
	});

	test("緩い agentId でも scopeId を導出できる", () => {
		const labels = buildAgentMetricLabels({
			agentId: "discord:guild-1",
			providerId: "test-provider",
			modelId: "test-model",
		});
		expect(labels.scope_id).toBe("discord:guild:guild-1");
		expect(labels.agent_kind).toBe("discord");
	});

	test("明示された scopeId を最優先する", () => {
		const labels = buildAgentMetricLabels({
			agentId: "discord:111",
			scopeId: "discord:guild:custom",
			providerId: "test-provider",
			modelId: "test-model",
		});
		expect(labels.scope_id).toBe("discord:guild:custom");
	});
});
