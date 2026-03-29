import { existsSync } from "fs";
import { resolve } from "path";

import type { MemoryFact, MemoryFactReader } from "@vicissitude/shared/types";

import { reciprocalRankFusion } from "./retrieval.ts";
import type { SemanticFact } from "./semantic-fact.ts";
import { MemoryStorage } from "./storage.ts";

const GUILD_ID_RE = /^\d+$/;

/** Candidate limit for text/vector search before RRF ranking */
const CANDIDATE_LIMIT = 50;

/** Maximum number of guideline facts to reserve in results */
const MAX_GUIDELINES = 3;

/** Embedding-only port — subset of MemoryLlmPort needed for fact relevance filtering */
export interface EmbeddingPort {
	embed(text: string): Promise<number[]>;
}

export class MemoryFactReaderImpl implements MemoryFactReader {
	private readonly instances = new Map<string, MemoryStorage>();

	constructor(
		private readonly dataDir: string,
		private readonly embedding?: EmbeddingPort,
	) {}

	async getFacts(guildId?: string): Promise<MemoryFact[]> {
		if (!guildId) return [];
		const rawFacts = await this.loadAllFacts(guildId);
		return rawFacts.map((f) => toFact(f));
	}

	async getRelevantFacts(guildId: string, context: string, limit: number): Promise<MemoryFact[]> {
		const allFacts = await this.loadAllFacts(guildId);
		if (allFacts.length <= limit) {
			return allFacts.map((f) => toFact(f));
		}

		// Separate guideline facts and reserve slots for them
		const guidelines: SemanticFact[] = [];
		const nonGuidelines: SemanticFact[] = [];
		for (const f of allFacts) {
			(f.category === "guideline" ? guidelines : nonGuidelines).push(f);
		}
		const reservedCount = Math.min(MAX_GUIDELINES, guidelines.length, limit);
		const reservedGuidelines = guidelines.slice(0, reservedCount);
		const remainingLimit = limit - reservedCount;

		if (!context.trim() || !this.embedding) {
			return [...reservedGuidelines, ...nonGuidelines.slice(0, remainingLimit)].map((f) =>
				toFact(f),
			);
		}

		const scored = await this.hybridSearchFacts(guildId, context);
		// Exclude guideline facts from diversity selection (they are already reserved)
		const reservedIds = new Set(reservedGuidelines.map((f) => f.id));
		const scoredNonGuideline = scored.filter((s) => !reservedIds.has(s.fact.id));
		const nonGuidelineFacts = allFacts.filter((f) => !reservedIds.has(f.id));
		const remaining = ensureCategoryDiversity(
			scoredNonGuideline,
			nonGuidelineFacts,
			remainingLimit,
		);

		return [...reservedGuidelines, ...remaining].map((f) => toFact(f));
	}

	close(): Promise<void> {
		for (const storage of this.instances.values()) {
			storage.close();
		}
		this.instances.clear();
		return Promise.resolve();
	}

	private loadAllFacts(guildId: string): Promise<SemanticFact[]> {
		if (!GUILD_ID_RE.test(guildId)) {
			throw new Error(`Invalid guildId: ${guildId}`);
		}
		const dbPath = resolve(this.dataDir, "guilds", guildId, "memory.db");
		if (!existsSync(dbPath)) return Promise.resolve([]);
		const storage = this.getOrCreate(guildId, dbPath);
		return storage.getFacts(guildId);
	}

	private async hybridSearchFacts(
		guildId: string,
		context: string,
	): Promise<{ fact: SemanticFact; score: number }[]> {
		const storage = this.instances.get(guildId);
		if (!storage || !this.embedding) return [];

		const [textFacts, queryEmbedding] = await Promise.all([
			storage.searchFacts(guildId, context, CANDIDATE_LIMIT),
			this.embedding.embed(context),
		]);
		const vectorFacts = await storage.searchFactsByEmbedding(
			guildId,
			queryEmbedding,
			CANDIDATE_LIMIT,
		);

		const rrfScores = reciprocalRankFusion(
			[
				{ items: textFacts, weight: 1.0 },
				{ items: vectorFacts, weight: 1.0 },
			],
			(f) => f.id,
		);

		const factMap = new Map([...textFacts, ...vectorFacts].map((f) => [f.id, f]));

		return [...rrfScores.entries()]
			.map(([id, score]) => ({ fact: factMap.get(id), score }))
			.filter((s): s is { fact: SemanticFact; score: number } => s.fact !== undefined)
			.toSorted((a, b) => b.score - a.score);
	}

	private getOrCreate(guildId: string, dbPath: string): MemoryStorage {
		const existing = this.instances.get(guildId);
		if (existing) return existing;

		const storage = new MemoryStorage(dbPath);
		this.instances.set(guildId, storage);
		return storage;
	}
}

function toFact(f: SemanticFact): MemoryFact {
	return {
		content: f.fact,
		category: f.category,
		createdAt: f.createdAt instanceof Date ? f.createdAt.toISOString() : String(f.createdAt),
	};
}

/**
 * Ensure category diversity: fill slots with top-scored facts,
 * but guarantee at least 1 fact per category that has facts (up to limit).
 */
function ensureCategoryDiversity(
	scored: { fact: SemanticFact; score: number }[],
	allFacts: SemanticFact[],
	limit: number,
): SemanticFact[] {
	const selected = new Map<string, SemanticFact>();

	// Build per-category best-scored lookup (O(scored) instead of O(categories × scored))
	const bestByCategory = new Map<string, SemanticFact>();
	for (const s of scored) {
		if (!bestByCategory.has(s.fact.category)) {
			bestByCategory.set(s.fact.category, s.fact);
		}
	}

	// 1. Pick top-scored fact per category (category diversity guarantee, up to limit)
	const categories = new Set(allFacts.map((f) => f.category));
	for (const cat of categories) {
		if (selected.size >= limit) break;
		const best = bestByCategory.get(cat);
		if (best) {
			selected.set(best.id, best);
		} else {
			const fallback = allFacts.find((f) => f.category === cat);
			if (fallback) {
				selected.set(fallback.id, fallback);
			}
		}
	}

	// 2. Fill remaining slots with top-scored facts
	for (const s of scored) {
		if (selected.size >= limit) break;
		if (!selected.has(s.fact.id)) {
			selected.set(s.fact.id, s.fact);
		}
	}

	return [...selected.values()];
}
