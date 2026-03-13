import { ConsolidationPipeline } from "./consolidation.ts";
import { EpisodicMemory } from "./episodic.ts";
import type { LtmLlmPort } from "./llm-port.ts";
import type { LtmStorage } from "./ltm-storage.ts";
import { Retrieval } from "./retrieval.ts";
import { Segmenter } from "./segmenter.ts";
import { SemanticMemory } from "./semantic-memory.ts";

// Re-export domain types
export type { CreateEpisodeParams, Episode } from "./episode.ts";
export { createEpisode } from "./episode.ts";
export type { FSRSCard } from "./fsrs.ts";
export { FSRS_CONFIG, retrievability, reviewCard } from "./fsrs.ts";
export type { CreateFactParams, SemanticFact } from "./semantic-fact.ts";
export { createFact } from "./semantic-fact.ts";
export type {
	ChatMessage,
	ConsolidationAction,
	FactCategory,
	MessageRole,
	ReviewRating,
} from "./types.ts";
export { SURPRISE_VALUES } from "./types.ts";

// Re-export LLM port
export type { LtmLlmPort, Schema } from "./llm-port.ts";

// Re-export core services
export { Segmenter } from "./segmenter.ts";
export type { SegmenterConfig, SegmentResult, SegmentationOutput } from "./segmenter.ts";
export { EpisodicMemory } from "./episodic.ts";
export type { ReviewOptions } from "./episodic.ts";
export { ConsolidationPipeline } from "./consolidation.ts";
export type { ConsolidationResult, ConsolidationOutput, ExtractedFact } from "./consolidation.ts";
export { SemanticMemory } from "./semantic-memory.ts";
export { Retrieval, reciprocalRankFusion } from "./retrieval.ts";
export type { RetrievalOptions, RetrievalResult, ScoredEpisode, ScoredFact } from "./retrieval.ts";

// Re-export storage
export { LtmStorage } from "./ltm-storage.ts";

/** Ltm instance — the main entry point */
export interface Ltm {
	segmenter: Segmenter;
	episodic: EpisodicMemory;
	consolidation: ConsolidationPipeline;
	semantic: SemanticMemory;
	retrieval: Retrieval;
}

/** Options for creating an Ltm instance */
export interface CreateLtmOptions {
	llm: LtmLlmPort;
	storage: LtmStorage;
}

/** Create an Ltm instance with the given adapters */
export function createLtm(opts: CreateLtmOptions): Ltm {
	const { llm, storage } = opts;

	const episodic = new EpisodicMemory(storage);
	const consolidation = new ConsolidationPipeline(llm, storage);
	const retrieval = new Retrieval(llm, storage);
	retrieval.setEpisodicMemory(episodic);
	consolidation.setEpisodicMemory(episodic);

	return {
		segmenter: new Segmenter(llm, storage),
		episodic,
		consolidation,
		semantic: new SemanticMemory(storage),
		retrieval,
	};
}
