import { describe, expect, it } from "bun:test";

import {
	buildAgentMetricLabels,
	inferAgentKind,
	inferScopeId,
	inferTrigger,
} from "@vicissitude/observability/metrics";

describe("agent metric labels", () => {
	it("Discord 会話エージェントを scope・トリガー・モデルで識別する", () => {
		expect(
			buildAgentMetricLabels({
				agentId: "discord:111111111111111111",
				scopeId: "discord:guild:111111111111111111",
				sessionKey: "home",
				providerId: "openai",
				modelId: "gpt-5.4",
			}),
		).toEqual({
			agent_kind: "discord",
			agent_id: "discord:111111111111111111",
			scope_id: "discord:guild:111111111111111111",
			trigger: "home",
			provider: "openai",
			model: "gpt-5.4",
		});
	});

	it("heartbeat と autonomous heartbeat を識別する", () => {
		expect(inferAgentKind("discord:heartbeat:111111111111111111")).toBe("discord_heartbeat");
		expect(inferTrigger("system:heartbeat:discord:guild:111111111111111111")).toBe("heartbeat");
		expect(inferScopeId("system:heartbeat:_autonomous")).toBe("_autonomous");
	});

	it("Minecraft エージェントを scope_id=none として識別する", () => {
		expect(
			buildAgentMetricLabels({
				agentId: "minecraft:brain",
				sessionKey: "minecraft:brain",
				providerId: "openai",
				modelId: "gpt-5.4",
			}),
		).toEqual({
			agent_kind: "minecraft",
			agent_id: "minecraft:brain",
			scope_id: "none",
			trigger: "minecraft",
			provider: "openai",
			model: "gpt-5.4",
		});
	});
});
