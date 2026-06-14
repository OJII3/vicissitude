import { ConsolidationPipeline } from "./consolidation.ts";
import { EpisodicMemory } from "./episodic.ts";
import type { MemoryLlmPort } from "./llm-port.ts";
import { Retrieval, RetrievalReviewCommand } from "./retrieval.ts";
import { Segmenter } from "./segmenter.ts";
import { SemanticMemory } from "./semantic-memory.ts";
import type { MemoryStorage } from "./storage.ts";

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
export { Retrieval, RetrievalReviewCommand, reciprocalRankFusion } from "./retrieval.ts";
export type {
	RetrievalOptions,
	RetrievalResult,
	RetrievalReviewOptions,
	ScoredEpisode,
	ScoredFact,
} from "./retrieval.ts";

// Re-export storage
export { MemoryStorage } from "./storage.ts";

/** Retrieval read port: 検索だけを公開し、FSRS review 更新 command を含めない */
export type MemoryRetrievalReadPort = Pick<Retrieval, "retrieve">;

/** Semantic read port: fact の読み取りだけを公開し、invalidate command を含めない */
export type MemorySemanticReadPort = Pick<
	SemanticMemory,
	"getFacts" | "getFactsByCategory" | "search"
>;

/** Memory の読み取り専用サブセット（retrieval + semantic read のみ） */
export interface MemoryReadServices {
	retrieval: MemoryRetrievalReadPort;
	semantic: MemorySemanticReadPort;
}

/** Semantic command port: fact の更新系 use case */
export type MemorySemanticCommandPort = Pick<SemanticMemory, "invalidate">;

/** Memory の明示 command/use case サブセット */
export interface MemoryCommandServices {
	segmenter: Segmenter;
	episodic: EpisodicMemory;
	consolidation: ConsolidationPipeline;
	retrievalReview: RetrievalReviewCommand;
	semantic: MemorySemanticCommandPort;
}

/** Memory instance — the main entry point */
export interface Memory {
	read: MemoryReadServices;
	commands: MemoryCommandServices;
	segmenter: Segmenter;
	episodic: EpisodicMemory;
	consolidation: ConsolidationPipeline;
	semantic: SemanticMemory;
	retrieval: Retrieval;
	retrievalReview: RetrievalReviewCommand;
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
	const segmenter = new Segmenter(llm, storage);
	const consolidation = new ConsolidationPipeline(llm, storage, episodic);
	const semantic = new SemanticMemory(storage);
	const retrieval = new Retrieval(llm, storage);
	const retrievalReview = new RetrievalReviewCommand(episodic);
	const read: MemoryReadServices = { retrieval, semantic };
	const commands: MemoryCommandServices = {
		segmenter,
		episodic,
		consolidation,
		retrievalReview,
		semantic,
	};

	return {
		read,
		commands,
		segmenter,
		episodic,
		consolidation,
		semantic,
		retrieval,
		retrievalReview,
	};
}
