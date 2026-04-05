export interface PortLayout {
	guild(index: number): number;
	minecraft(): number;
	heartbeat(index: number): number;
	/** createGuildAgents の portOffset に渡す相対オフセット */
	heartbeatOffset: number;
	listening(index: number): number;
	/** createGuildAgents の portOffset に渡す相対オフセット（listening 用） */
	listeningOffset: number;
	memory(): number;
}

export function createPortLayout(basePort: number, guildCount: number): PortLayout {
	const heartbeatOffset = guildCount + 1;
	const listeningOffset = heartbeatOffset + guildCount;
	return {
		guild: (index) => basePort + index,
		minecraft: () => basePort + guildCount,
		heartbeat: (index) => basePort + heartbeatOffset + index,
		heartbeatOffset,
		listening: (index) => basePort + listeningOffset + index,
		listeningOffset,
		memory: () => basePort - 2,
	};
}
