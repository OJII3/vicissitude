export interface SessionRepository {
	get(agentName: string, sessionKey: string): string | undefined;
	save(agentName: string, sessionKey: string, agentSessionId: string): Promise<void>;
	exists(agentName: string, sessionKey: string): boolean;
}
