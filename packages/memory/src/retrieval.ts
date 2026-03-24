import type { Episode } from "./episode.ts";
import type { EpisodicMemory } from "./episodic.ts";
import { retrievability } from "./fsrs.ts";
import type { MemoryLlmPort } from "./llm-port.ts";
import type { SemanticFact } from "./semantic-fact.ts";
import type { MemoryStorage } from "./storage.ts";
import { validateUserId } from "./utils.ts";

/** Options for configuring retrieval behavior */
export interface RetrievalOptions {
	/** Maximum number of results per category (default 10) */
	limit?: number;
	/** Weight for text search ranking in RRF (default 1.0) */
	textWeight?: number;
	/** Weight for vector search ranking in RRF (default 1.0) */
	vectorWeight?: number;
	/** Weight for FSRS retrievability boost on episodes (default 0.5) */
	fsrsWeight?: number;
	/** Current time — injectable for testing (default new Date()) */
	now?: Date;
}

/** An episode with its retrieval score and retrievability */
export interface ScoredEpisode {
	episode: Episode;
	score: number;
	retrievability: number;
}

/** A semantic fact with its retrieval score */
export interface ScoredFact {
	fact: SemanticFact;
	score: number;
}

/** Combined retrieval result */
export interface RetrievalResult {
	episodes: ScoredEpisode[];
	facts: ScoredFact[];
}

/** RRF constant (TREC standard) */
const RRF_K = 60;

/**
 * Reciprocal Rank Fusion — merge multiple ranked lists into a single score map.
 *
 * @param rankedLists Array of { items, weight } where items are in rank order (best first)
 * @param getId Function to extract a unique key from each item
 * @returns Map of id → fused score
 */
export function reciprocalRankFusion<T>(
	rankedLists: { items: T[]; weight: number }[],
	getId: (item: T) => string,
): Map<string, number> {
	const scores = new Map<string, number>();
	for (const { items, weight } of rankedLists) {
		for (let rank = 0; rank < items.length; rank++) {
			const item = items[rank];
			if (item !== undefined) {
				const id = getId(item);
				const prev = scores.get(id) ?? 0;
				scores.set(id, prev + weight / (RRF_K + rank + 1));
			}
		}
	}
	return scores;
}

/** Build an id → item lookup map from multiple arrays */
function buildLookup<T extends { id: string }>(...lists: T[][]): Map<string, T> {
	const map = new Map<string, T>();
	for (const list of lists) {
		for (const item of list) {
			map.set(item.id, item);
		}
	}
	return map;
}

interface EpisodeScoringContext {
	rrfScores: Map<string, number>;
	episodeMap: Map<string, Episode>;
	fsrsWeight: number;
	now: Date;
}

/** Score episodes by combining RRF scores with FSRS retrievability */
function scoreEpisodes(ctx: EpisodeScoringContext): ScoredEpisode[] {
	const scored: ScoredEpisode[] = [];
	for (const [id, rrfScore] of ctx.rrfScores) {
		const episode = ctx.episodeMap.get(id);
		if (episode) {
			const r = retrievability(
				{
					stability: episode.stability,
					difficulty: episode.difficulty,
					lastReviewedAt: episode.lastReviewedAt,
				},
				ctx.now,
			);
			scored.push({ episode, score: rrfScore + ctx.fsrsWeight * r, retrievability: r });
		}
	}
	return scored.toSorted((a, b) => b.score - a.score);
}

/** Score facts by RRF scores */
function scoreFacts(
	rrfScores: Map<string, number>,
	factMap: Map<string, SemanticFact>,
): ScoredFact[] {
	const scored: ScoredFact[] = [];
	for (const [id, score] of rrfScores) {
		const fact = factMap.get(id);
		if (fact) {
			scored.push({ fact, score });
		}
	}
	return scored.toSorted((a, b) => b.score - a.score);
}

/** Default candidate limit for search queries */
const CANDIDATE_LIMIT = 50;

interface ResolvedOptions {
	limit: number;
	textWeight: number;
	vectorWeight: number;
	fsrsWeight: number;
	now: Date;
}

function resolveOptions(options: RetrievalOptions): ResolvedOptions {
	const {
		limit: rawLimit = 10,
		textWeight = 1.0,
		vectorWeight = 1.0,
		fsrsWeight = 0.5,
		now = new Date(),
	} = options;
	return {
		limit: Math.max(1, Math.min(Math.floor(rawLimit), 1000)),
		textWeight,
		vectorWeight,
		fsrsWeight,
		now,
	};
}

interface RankContext {
	textEpisodes: Episode[];
	vectorEpisodes: Episode[];
	textFacts: SemanticFact[];
	vectorFacts: SemanticFact[];
	opts: ResolvedOptions;
}

/** Rank search results by RRF + FSRS boost */
function rankResults(ctx: RankContext): RetrievalResult {
	const { textEpisodes, vectorEpisodes, textFacts, vectorFacts, opts } = ctx;

	const episodeRrf = reciprocalRankFusion(
		[
			{ items: textEpisodes, weight: opts.textWeight },
			{ items: vectorEpisodes, weight: opts.vectorWeight },
		],
		(ep) => ep.id,
	);
	const episodes = scoreEpisodes({
		rrfScores: episodeRrf,
		episodeMap: buildLookup(textEpisodes, vectorEpisodes),
		fsrsWeight: opts.fsrsWeight,
		now: opts.now,
	}).slice(0, opts.limit);

	const factRrf = reciprocalRankFusion(
		[
			{ items: textFacts, weight: opts.textWeight },
			{ items: vectorFacts, weight: opts.vectorWeight },
		],
		(f) => f.id,
	);
	const facts = scoreFacts(factRrf, buildLookup(textFacts, vectorFacts)).slice(0, opts.limit);

	return { episodes, facts };
}

/** Retrieval service — hybrid search with FSRS reranking */
export class Retrieval {
	private pendingReview: Promise<void> = Promise.resolve();

	constructor(
		private llm: MemoryLlmPort,
		private storage: MemoryStorage,
		private episodic: EpisodicMemory | null = null,
	) {}

	/** Wait for any pending FSRS reviews to complete (useful in tests and graceful shutdown) */
	flushReviews(): Promise<void> {
		return this.pendingReview;
	}

	/** Run all 4 searches in parallel */
	private runSearches(
		userId: string,
		query: string,
		queryEmbedding: number[],
	): Promise<[Episode[], SemanticFact[], Episode[], SemanticFact[]]> {
		return Promise.all([
			this.storage.searchEpisodes(userId, query, CANDIDATE_LIMIT),
			this.storage.searchFacts(userId, query, CANDIDATE_LIMIT),
			this.storage.searchEpisodesByEmbedding(userId, queryEmbedding, CANDIDATE_LIMIT),
			this.storage.searchFactsByEmbedding(userId, queryEmbedding, CANDIDATE_LIMIT),
		]);
	}

	/** Retrieve memories matching a query using hybrid text+vector search with FSRS reranking */
	async retrieve(
		userId: string,
		query: string,
		options: RetrievalOptions = {},
	): Promise<RetrievalResult> {
		validateUserId(userId);
		if (query === "") {
			return { episodes: [], facts: [] };
		}
		const opts = resolveOptions(options);
		const queryEmbedding = await this.llm.embed(query);
		const [textEpisodes, textFacts, vectorEpisodes, vectorFacts] = await this.runSearches(
			userId,
			query,
			queryEmbedding,
		);
		const result = rankResults({ textEpisodes, vectorEpisodes, textFacts, vectorFacts, opts });

		// FSRS learning loop: fire-and-forget auto-review so returned scores
		// reflect the pre-review state and remain consistent with this response.
		if (this.episodic && result.episodes.length > 0) {
			this.pendingReview = this.reviewRetrievedEpisodes(userId, result.episodes, opts.now);
		}

		return result;
	}

	/** Max episodes to auto-review per retrieve call to bound DB write cost */
	private static readonly MAX_AUTO_REVIEW = 20;

	/** Review retrieved episodes to update FSRS parameters (search hit = "good") */
	private async reviewRetrievedEpisodes(
		userId: string,
		episodes: ScoredEpisode[],
		now: Date,
	): Promise<void> {
		const { episodic } = this;
		if (!episodic) return;
		const toReview = episodes.slice(0, Retrieval.MAX_AUTO_REVIEW);
		await Promise.all(
			toReview.map((ep) => episodic.review(userId, ep.episode.id, { rating: "good", now })),
		);
	}
}
