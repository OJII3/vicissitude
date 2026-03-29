import { describe, expect, it, mock } from "bun:test";

import { GuildRouter } from "@vicissitude/agent/discord/router";
import type { AgentResponse, AiAgent, SendOptions } from "@vicissitude/shared/types";

// ─── ヘルパー ────────────────────────────────────────────────────

function createMockAgent(name: string): AiAgent {
	return {
		send: mock(
			(_opts: SendOptions): Promise<AgentResponse> =>
				Promise.resolve({
					text: `response from ${name}`,
					sessionId: `sid-${name}`,
				}),
		),
		stop: mock(() => {}),
	};
}

// ─── GuildRouter ─────────────────────────────────────────────────

describe("GuildRouter", () => {
	it("登録済み guildId で正しいエージェントに委譲される", async () => {
		const agentA = createMockAgent("a");
		const agentB = createMockAgent("b");
		const agents = new Map<string, AiAgent>([
			["guild-a", agentA],
			["guild-b", agentB],
		]);
		const router = new GuildRouter(agents);

		const opts: SendOptions = { sessionKey: "key", message: "hello", guildId: "guild-a" };
		const result = await router.send(opts);

		expect(result.text).toBe("response from a");
		expect(agentA.send).toHaveBeenCalledTimes(1);
		expect(agentB.send).not.toHaveBeenCalled();
	});

	it("guildId 未指定 + defaultAgent なしの場合にエラーがスローされる", () => {
		const router = new GuildRouter(new Map());

		const opts: SendOptions = { sessionKey: "key", message: "hello" };
		expect(router.send(opts)).rejects.toThrow("GuildRouter requires guildId");
	});

	it("guildId 未指定 + defaultAgent ありの場合に defaultAgent に委譲される", async () => {
		const defaultAgent = createMockAgent("default");
		const router = new GuildRouter(new Map(), defaultAgent);

		const opts: SendOptions = { sessionKey: "key", message: "hello" };
		const result = await router.send(opts);

		expect(result.text).toBe("response from default");
		expect(defaultAgent.send).toHaveBeenCalledTimes(1);
	});

	it("未登録の guildId の場合にエラーがスローされる", () => {
		const agentA = createMockAgent("a");
		const agents = new Map<string, AiAgent>([["guild-a", agentA]]);
		const router = new GuildRouter(agents);

		const opts: SendOptions = { sessionKey: "key", message: "hello", guildId: "guild-unknown" };
		expect(router.send(opts)).rejects.toThrow("No agent registered for guildId: guild-unknown");
	});

	it("stop() が全エージェントに伝播される", () => {
		const agentA = createMockAgent("a");
		const agentB = createMockAgent("b");
		const agents = new Map<string, AiAgent>([
			["guild-a", agentA],
			["guild-b", agentB],
		]);
		const router = new GuildRouter(agents);

		router.stop();

		expect(agentA.stop).toHaveBeenCalledTimes(1);
		expect(agentB.stop).toHaveBeenCalledTimes(1);
	});
});
