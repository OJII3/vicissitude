import type { AgentResponse, AiAgent, SendOptions } from "@vicissitude/shared/types";

/**
 * scopeId に基づいて適切な Discord 会話エージェントにルーティングするファサード。
 * scopeId が未指定の場合は defaultAgent にフォールバックする。
 */
export class ScopeRouter implements AiAgent {
	private readonly agents: Map<string, AiAgent>;
	private readonly defaultAgent: AiAgent | undefined;

	constructor(scopeAgents: Map<string, AiAgent>, defaultAgent?: AiAgent) {
		this.agents = scopeAgents;
		this.defaultAgent = defaultAgent;
	}

	send(options: SendOptions): Promise<AgentResponse> {
		const { scopeId } = options;
		if (!scopeId) {
			if (!this.defaultAgent) {
				return Promise.reject(
					new Error("ScopeRouter requires scopeId in SendOptions (no defaultAgent configured)"),
				);
			}
			return this.defaultAgent.send(options);
		}
		const agent = this.agents.get(scopeId);
		if (!agent) {
			return Promise.reject(new Error(`No agent registered for scopeId: ${scopeId}`));
		}
		return agent.send(options);
	}

	stop(): void {
		for (const agent of this.agents.values()) {
			agent.stop();
		}
		// defaultAgent が agents Map に含まれていない場合のみ停止
		if (this.defaultAgent && ![...this.agents.values()].includes(this.defaultAgent)) {
			this.defaultAgent.stop();
		}
	}
}

export { ScopeRouter as GuildRouter };
