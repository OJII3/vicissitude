import type { AgentResponse, Attachment } from "../core/types.ts";

export interface SendOptions {
	sessionKey: string;
	message: string;
	guildId?: string;
	attachments?: Attachment[];
}

export interface AiAgent {
	send(options: SendOptions): Promise<AgentResponse>;
	stop(): void;
}

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
				throw new Error("GuildRouter requires guildId in SendOptions (no defaultAgent configured)");
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
