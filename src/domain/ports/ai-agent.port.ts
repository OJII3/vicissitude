import type { AgentResponse } from "../entities/agent-response.ts";

export interface AiAgent {
	send(sessionKey: string, message: string): Promise<AgentResponse>;
	stop(): void;
}
