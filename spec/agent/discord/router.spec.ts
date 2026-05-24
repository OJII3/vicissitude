import { describe, expect, it, mock } from "bun:test";

import { ScopeRouter } from "@vicissitude/agent/discord/router";
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

// ─── ScopeRouter ─────────────────────────────────────────────────

describe("ScopeRouter", () => {
	it("登録済み scopeId で正しいエージェントに委譲される", async () => {
		const agentA = createMockAgent("a");
		const agentB = createMockAgent("b");
		const agents = new Map<string, AiAgent>([
			["discord:guild:111", agentA],
			["discord:guild:222", agentB],
		]);
		const router = new ScopeRouter(agents);

		const opts: SendOptions = {
			sessionKey: "key",
			message: "hello",
			scopeId: "discord:guild:111",
		};
		const result = await router.send(opts);

		expect(result.text).toBe("response from a");
		expect(agentA.send).toHaveBeenCalledTimes(1);
		expect(agentB.send).not.toHaveBeenCalled();
	});

	it("scopeId 未指定 + defaultAgent なしの場合にエラーがスローされる", () => {
		const router = new ScopeRouter(new Map());

		const opts: SendOptions = { sessionKey: "key", message: "hello" };
		expect(router.send(opts)).rejects.toThrow("ScopeRouter requires scopeId");
	});

	it("scopeId 未指定 + defaultAgent ありの場合に defaultAgent に委譲される", async () => {
		const defaultAgent = createMockAgent("default");
		const router = new ScopeRouter(new Map(), defaultAgent);

		const opts: SendOptions = { sessionKey: "key", message: "hello" };
		const result = await router.send(opts);

		expect(result.text).toBe("response from default");
		expect(defaultAgent.send).toHaveBeenCalledTimes(1);
	});

	it("未登録の scopeId の場合にエラーがスローされる", () => {
		const agentA = createMockAgent("a");
		const agents = new Map<string, AiAgent>([["discord:guild:111", agentA]]);
		const router = new ScopeRouter(agents);

		const opts: SendOptions = {
			sessionKey: "key",
			message: "hello",
			scopeId: "discord:guild:999",
		};
		expect(router.send(opts)).rejects.toThrow("No agent registered for scopeId: discord:guild:999");
	});

	it("Discord DM scopeId でも正しいエージェントに委譲される", async () => {
		const dmAgent = createMockAgent("dm");
		const router = new ScopeRouter(new Map<string, AiAgent>([["discord:dm:999", dmAgent]]));

		const result = await router.send({
			sessionKey: "dm",
			message: "hello",
			scopeId: "discord:dm:999",
		});

		expect(result.text).toBe("response from dm");
		expect(dmAgent.send).toHaveBeenCalledTimes(1);
	});

	it("stop() が全エージェントに伝播される", () => {
		const agentA = createMockAgent("a");
		const agentB = createMockAgent("b");
		const agents = new Map<string, AiAgent>([
			["discord:guild:111", agentA],
			["discord:dm:222", agentB],
		]);
		const router = new ScopeRouter(agents);

		router.stop();

		expect(agentA.stop).toHaveBeenCalledTimes(1);
		expect(agentB.stop).toHaveBeenCalledTimes(1);
	});
});
