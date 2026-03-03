import type { AgentResponse } from "../../domain/entities/agent-response.ts";
import type { AiAgent, SendOptions } from "../../domain/ports/ai-agent.port.ts";

/**
 * ギルドIDに基づいて適切なギルド固有エージェントにルーティングするファサード。
 * Heartbeat などの既存ユースケースが AiAgent インターフェースをそのまま使えるようにする。
 * guildId が未指定の場合は defaultAgent にフォールバックする。
 */
export class GuildRoutingAgent implements AiAgent {
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
				throw new Error(
					"GuildRoutingAgent requires guildId in SendOptions (no defaultAgent configured)",
				);
			}
			return this.defaultAgent.send(options);
		}
		const agent = this.agents.get(guildId);
		if (!agent) {
			throw new Error(`No agent registered for guildId: ${guildId}`);
		}
		return agent.send(options);
	}

	stop(): void {
		for (const agent of this.agents.values()) {
			agent.stop();
		}
	}
}
