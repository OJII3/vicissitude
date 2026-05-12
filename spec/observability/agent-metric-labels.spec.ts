import { describe, expect, it } from "bun:test";

import {
	buildAgentMetricLabels,
	inferAgentKind,
	inferGuildId,
	inferTrigger,
} from "@vicissitude/observability/metrics";

describe("agent metric labels", () => {
	it("Discord 会話エージェントをギルド・トリガー・モデルで識別する", () => {
		expect(
			buildAgentMetricLabels({
				agentId: "discord:guild-1",
				guildId: "guild-1",
				sessionKey: "home",
				providerId: "openai",
				modelId: "gpt-5.4",
			}),
		).toEqual({
			agent_kind: "discord",
			agent_id: "discord:guild-1",
			guild_id: "guild-1",
			trigger: "home",
			provider: "openai",
			model: "gpt-5.4",
		});
	});

	it("heartbeat と autonomous heartbeat を識別する", () => {
		expect(inferAgentKind("discord:heartbeat:guild-1")).toBe("discord_heartbeat");
		expect(inferTrigger("system:heartbeat:guild-1")).toBe("heartbeat");
		expect(inferGuildId("system:heartbeat:_autonomous")).toBe("_autonomous");
	});

	it("Minecraft エージェントを guild_id=none として識別する", () => {
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
			guild_id: "none",
			trigger: "minecraft",
			provider: "openai",
			model: "gpt-5.4",
		});
	});
});
