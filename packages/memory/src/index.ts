import { ConsolidationPipeline } from "./consolidation.ts";
import { EpisodicMemory } from "./episodic.ts";
import type { MemoryLlmPort } from "./llm-port.ts";
import type { MemoryStorage } from "./storage.ts";
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
export type { MemoryLlmPort, Schema } from "./llm-port.ts";

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
export { MemoryStorage } from "./storage.ts";

/** Memory instance — the main entry point */
export interface Memory {
	segmenter: Segmenter;
	episodic: EpisodicMemory;
	consolidation: ConsolidationPipeline;
	semantic: SemanticMemory;
	retrieval: Retrieval;
}

/** Options for creating a Memory instance */
export interface CreateMemoryOptions {
	llm: MemoryLlmPort;
	storage: MemoryStorage;
}

/** Create a Memory instance with the given adapters */
export function createMemory(opts: CreateMemoryOptions): Memory {
	const { llm, storage } = opts;

	const episodic = new EpisodicMemory(storage);

	return {
		segmenter: new Segmenter(llm, storage),
		episodic,
		consolidation: new ConsolidationPipeline(llm, storage, episodic),
		semantic: new SemanticMemory(storage),
		retrieval: new Retrieval(llm, storage, episodic),
	};
}
