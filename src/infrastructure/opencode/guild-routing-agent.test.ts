import { describe, expect, it, mock } from "bun:test";

import type { AgentResponse } from "../../domain/entities/agent-response.ts";
import type { AiAgent, SendOptions } from "../../domain/ports/ai-agent.port.ts";
import { GuildRoutingAgent } from "./guild-routing-agent.ts";

function createMockAgent(): AiAgent {
	return {
		send: mock(() => Promise.resolve({ text: "ok", sessionId: "s1" } satisfies AgentResponse)),
		stop: mock(() => {}),
	};
}

function createSendOptions(guildId?: string): SendOptions {
	return {
		sessionKey: "test-key",
		message: "hello",
		guildId,
	};
}

describe("GuildRoutingAgent", () => {
	it("登録済み guildId で正しいエージェントに委譲される", async () => {
		const agentA = createMockAgent();
		const agentB = createMockAgent();
		const agents = new Map<string, AiAgent>([
			["111", agentA],
			["222", agentB],
		]);
		const router = new GuildRoutingAgent(agents);

		await router.send(createSendOptions("222"));

		expect(agentA.send).not.toHaveBeenCalled();
		expect(agentB.send).toHaveBeenCalledTimes(1);
	});

	it("guildId が undefined の場合にエラーがスローされる", () => {
		const router = new GuildRoutingAgent(new Map());

		expect(() => router.send(createSendOptions())).toThrow(
			"GuildRoutingAgent requires guildId in SendOptions",
		);
	});

	it("未登録の guildId の場合にエラーがスローされる", () => {
		const router = new GuildRoutingAgent(new Map([["111", createMockAgent()]]));

		expect(() => router.send(createSendOptions("999"))).toThrow(
			"No agent registered for guildId: 999",
		);
	});

	it("stop() が全エージェントに伝播される", () => {
		const agentA = createMockAgent();
		const agentB = createMockAgent();
		const agents = new Map<string, AiAgent>([
			["111", agentA],
			["222", agentB],
		]);
		const router = new GuildRoutingAgent(agents);

		router.stop();

		expect(agentA.stop).toHaveBeenCalledTimes(1);
		expect(agentB.stop).toHaveBeenCalledTimes(1);
	});
});
