export interface PortLayout {
	guild(index: number): number;
	minecraft(): number;
	heartbeat(index: number): number;
	memory(): number;
}

export function createPortLayout(basePort: number, guildCount: number): PortLayout {
	return {
		guild: (index) => basePort + index,
		minecraft: () => basePort + guildCount,
		heartbeat: (index) => basePort + guildCount + 1 + index,
		memory: () => basePort - 2,
	};
}
