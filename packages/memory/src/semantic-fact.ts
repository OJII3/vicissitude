import type { FactCategory } from "./types.ts";

/** A semantic memory — a persistent fact extracted from episodes */
export interface SemanticFact {
	id: string;
	userId: string;
	category: FactCategory;
	fact: string;
	keywords: string[];
	sourceEpisodicIds: string[];
	embedding: number[];
	validAt: Date;
	invalidAt: Date | null;
	createdAt: Date;
}

/** Parameters for creating a new semantic fact */
export interface CreateFactParams {
	userId: string;
	category: FactCategory;
	fact: string;
	keywords: string[];
	sourceEpisodicIds: string[];
	embedding: number[];
	now: Date;
}

/** Create a new SemanticFact */
export function createFact(params: CreateFactParams): SemanticFact {
	const { now, ...factParams } = params;
	return {
		id: crypto.randomUUID(),
		...factParams,
		validAt: now,
		invalidAt: null,
		createdAt: now,
	};
}
