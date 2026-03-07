export interface ConsolidationResult {
	processedEpisodes: number;
	newFacts: number;
	reinforced: number;
	updated: number;
	invalidated: number;
}

export interface MemoryConsolidator {
	getActiveGuildIds(): string[];
	consolidate(guildId: string): Promise<ConsolidationResult>;
}
