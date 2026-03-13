import { existsSync } from "fs";
import { resolve } from "path";

import type { LtmFact, LtmFactReader } from "../core/types.ts";
import { LtmStorage } from "./ltm-storage.ts";
import { reciprocalRankFusion } from "./retrieval.ts";
import type { SemanticFact } from "./semantic-fact.ts";

const GUILD_ID_RE = /^\d+$/;

/** Candidate limit for text/vector search before RRF ranking */
const CANDIDATE_LIMIT = 50;

/** Embedding-only port — subset of LtmLlmPort needed for fact relevance filtering */
export interface EmbeddingPort {
	embed(text: string): Promise<number[]>;
}

export class LtmFactReaderImpl implements LtmFactReader {
	private readonly instances = new Map<string, LtmStorage>();

	constructor(
		private readonly dataDir: string,
		private readonly embedding?: EmbeddingPort,
	) {}

	async getFacts(guildId?: string): Promise<LtmFact[]> {
		if (!guildId) return [];

		if (!GUILD_ID_RE.test(guildId)) {
			throw new Error(`Invalid guildId: ${guildId}`);
		}

		const dbPath = resolve(this.dataDir, "guilds", guildId, "memory.db");
		if (!existsSync(dbPath)) return [];

		const storage = this.getOrCreate(guildId, dbPath);
		const rawFacts = await storage.getFacts(guildId);
		return rawFacts.map((f) => toFact(f));
	}

	async getRelevantFacts(guildId: string, context: string, limit: number): Promise<LtmFact[]> {
		const allFacts = await this.loadAllFacts(guildId);
		if (allFacts.length <= limit) {
			return allFacts.map((f) => toFact(f));
		}
		if (!context.trim() || !this.embedding) {
			return allFacts.slice(0, limit).map((f) => toFact(f));
		}
		const scored = await this.hybridSearchFacts(guildId, context);
		return ensureCategoryDiversity(scored, allFacts, limit).map((f) => toFact(f));
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
		const dbPath = resolve(this.dataDir, "guilds", guildId, "memory.db");
		const storage = this.getOrCreate(guildId, dbPath);

		const embed = this.embedding;
		if (!embed) return [];
		const [textFacts, queryEmbedding] = await Promise.all([
			storage.searchFacts(guildId, context, CANDIDATE_LIMIT),
			embed.embed(context),
		]);
		const vectorFacts = await storage.searchFactsByEmbedding(guildId, queryEmbedding, CANDIDATE_LIMIT);

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

	private getOrCreate(guildId: string, dbPath: string): LtmStorage {
		const existing = this.instances.get(guildId);
		if (existing) return existing;

		const storage = new LtmStorage(dbPath);
		this.instances.set(guildId, storage);
		return storage;
	}
}

function toFact(f: SemanticFact): LtmFact {
	return {
		content: f.fact,
		category: f.category,
		createdAt: f.createdAt instanceof Date ? f.createdAt.toISOString() : String(f.createdAt),
	};
}

/**
 * Ensure category diversity: fill slots with top-scored facts,
 * but guarantee at least 1 fact per category that has facts.
 */
function ensureCategoryDiversity(
	scored: { fact: SemanticFact; score: number }[],
	allFacts: SemanticFact[],
	limit: number,
): SemanticFact[] {
	const categories = new Set(allFacts.map((f) => f.category));
	const selected = new Map<string, SemanticFact>();

	// 1. Pick top-scored fact per category (category diversity guarantee)
	for (const cat of categories) {
		const best = scored.find((s) => s.fact.category === cat);
		if (best) {
			selected.set(best.fact.id, best.fact);
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
