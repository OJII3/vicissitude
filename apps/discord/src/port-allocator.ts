export interface PortLayout {
	guild(index: number): number;
	minecraft(): number;
	heartbeat(index: number): number;
	/** createGuildAgents の portOffset に渡す相対オフセット */
	heartbeatOffset: number;
	webAgent(): number;
	memory(): number;
}

export function createPortLayout(basePort: number, guildCount: number): PortLayout {
	const heartbeatOffset = guildCount + 1;
	return {
		guild: (index) => basePort + index,
		minecraft: () => basePort + guildCount,
		heartbeat: (index) => basePort + heartbeatOffset + index,
		heartbeatOffset,
		webAgent: () => basePort + heartbeatOffset + guildCount,
		memory: () => basePort - 2,
	};
}
