import type { AgentResponse } from "../../domain/entities/agent-response.ts";
import type { AiAgent, SendOptions } from "../../domain/ports/ai-agent.port.ts";

/**
 * ギルドIDに基づいて適切なギルド固有エージェントにルーティングするファサード。
 * Heartbeat などの既存ユースケースが AiAgent インターフェースをそのまま使えるようにする。
 */
export class GuildRoutingAgent implements AiAgent {
	private readonly agents: Map<string, AiAgent>;

	constructor(guildAgents: Map<string, AiAgent>) {
		this.agents = guildAgents;
	}

	send(options: SendOptions): Promise<AgentResponse> {
		const { guildId } = options;
		if (!guildId) {
			throw new Error("GuildRoutingAgent requires guildId in SendOptions");
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
