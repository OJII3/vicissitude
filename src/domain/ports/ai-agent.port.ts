import type { AgentResponse } from "../entities/agent-response.ts";

export interface SendOptions {
	sessionKey: string;
	message: string;
	guildId?: string;
}

export interface AiAgent {
	send(options: SendOptions): Promise<AgentResponse>;
	stop(): void;
}
