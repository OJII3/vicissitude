import type { AgentResponse, AiAgent, SendOptions } from "../../core/types.ts";

export type { AiAgent, SendOptions } from "../../core/types.ts";

/**
 * ギルドIDに基づいて適切なギルド固有エージェントにルーティングするファサード。
 * guildId が未指定の場合は defaultAgent にフォールバックする。
 */
export class GuildRouter implements AiAgent {
	private readonly agents: Map<string, AiAgent>;
	private readonly defaultAgent: AiAgent | undefined;

	constructor(guildAgents: Map<string, AiAgent>, defaultAgent?: AiAgent) {
		this.agents = guildAgents;
		this.defaultAgent = defaultAgent;
	}

	send(options: SendOptions): Promise<AgentResponse> {
		const { guildId } = options;
		if (!guildId) {
			if (!this.defaultAgent) {
				return Promise.reject(
					new Error("GuildRouter requires guildId in SendOptions (no defaultAgent configured)"),
				);
			}
			return this.defaultAgent.send(options);
		}
		const agent = this.agents.get(guildId);
		if (!agent) {
			return Promise.reject(new Error(`No agent registered for guildId: ${guildId}`));
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
