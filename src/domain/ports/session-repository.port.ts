export interface SessionRepository {
	get(agentName: string, sessionKey: string): string | undefined;
	save(agentName: string, sessionKey: string, agentSessionId: string): Promise<void>;
	delete(agentName: string, sessionKey: string): Promise<void>;
	exists(agentName: string, sessionKey: string): boolean;
	count(): number;
	getCreatedAt(agentName: string, sessionKey: string): number | undefined;
}
