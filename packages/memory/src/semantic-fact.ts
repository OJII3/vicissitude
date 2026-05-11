import type { FactCategory } from "./types.ts";

export type SemanticFactSource = "consolidation" | "critic-auditor" | "listening";

export interface SemanticFactMetadata {
	source?: SemanticFactSource;
	guidelineAuthority?: "audit-candidate";
}

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
	metadata: SemanticFactMetadata;
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
	metadata?: SemanticFactMetadata;
}

/** Create a new SemanticFact */
export function createFact(params: CreateFactParams): SemanticFact {
	const { now, metadata = {}, ...factParams } = params;
	return {
		id: crypto.randomUUID(),
		...factParams,
		validAt: now,
		invalidAt: null,
		createdAt: now,
		metadata,
	};
}
