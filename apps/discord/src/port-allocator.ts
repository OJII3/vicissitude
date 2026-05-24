export interface PortLayout {
	conversation(index: number): number;
	minecraft(): number;
	heartbeat(index: number): number;
	/** createDiscordAgents の heartbeat portOffset に渡す相対オフセット */
	heartbeatOffset: number;
	webAgent(): number;
	memory(): number;
}

export function createPortLayout(
	basePort: number,
	conversationAgentCount: number,
	heartbeatAgentCount: number,
): PortLayout {
	const heartbeatOffset = conversationAgentCount + 1;
	return {
		conversation: (index) => basePort + index,
		minecraft: () => basePort + conversationAgentCount,
		heartbeat: (index) => basePort + heartbeatOffset + index,
		heartbeatOffset,
		webAgent: () => basePort + heartbeatOffset + heartbeatAgentCount,
		memory: () => basePort - 2,
	};
}
