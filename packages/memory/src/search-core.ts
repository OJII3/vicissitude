import type { SemanticFact } from "./semantic-fact.ts";

/** Candidate limit for text/vector search before RRF ranking */
export const CANDIDATE_LIMIT = 50;

/** Default RRF weight for the text-search ranked list */
export const DEFAULT_TEXT_WEIGHT = 1.0;

/** Default RRF weight for the vector-search ranked list */
export const DEFAULT_VECTOR_WEIGHT = 1.0;

/** RRF constant (TREC standard) */
export const RRF_K = 60;

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

/** A semantic fact paired with its fused retrieval score */
export interface ScoredFact {
	fact: SemanticFact;
	score: number;
}

/**
 * Fact-only hybrid ranking primitive.
 *
 * Merges text- and vector-search fact candidates via Reciprocal Rank Fusion
 * and returns them sorted by fused score (descending). Pure function — does no
 * I/O; callers supply the already-fetched candidate lists.
 *
 * @param textFacts Facts from text search, in rank order (best first)
 * @param vectorFacts Facts from vector search, in rank order (best first)
 * @param weights Optional RRF weights (default: text 1.0 / vector 1.0)
 */
export function hybridSearchFactsRRF(
	textFacts: SemanticFact[],
	vectorFacts: SemanticFact[],
	weights: { textWeight?: number; vectorWeight?: number } = {},
): ScoredFact[] {
	const { textWeight = DEFAULT_TEXT_WEIGHT, vectorWeight = DEFAULT_VECTOR_WEIGHT } = weights;

	const rrfScores = reciprocalRankFusion(
		[
			{ items: textFacts, weight: textWeight },
			{ items: vectorFacts, weight: vectorWeight },
		],
		(f) => f.id,
	);

	const factMap = new Map([...textFacts, ...vectorFacts].map((f) => [f.id, f]));

	return [...rrfScores.entries()]
		.map(([id, score]) => ({ fact: factMap.get(id), score }))
		.filter((s): s is ScoredFact => s.fact !== undefined)
		.toSorted((a, b) => b.score - a.score);
}
