export interface LtmFact {
	content: string;
	category: string;
	createdAt: string;
}

export interface LtmFactReader {
	getFacts(guildId?: string): Promise<LtmFact[]>;
	close(): Promise<void>;
}
