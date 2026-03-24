import type { SemanticFact } from "./semantic-fact.ts";
/* oxlint-disable require-await -- methods are async for API compatibility */
import type { MemoryStorage } from "./storage.ts";
import type { FactCategory } from "./types.ts";
import { validateUserId } from "./utils.ts";

/** Semantic memory service — manages persistent facts extracted from episodes */
export class SemanticMemory {
	constructor(protected storage: MemoryStorage) {}

	/** Get all valid facts for a user */
	async getFacts(userId: string): Promise<SemanticFact[]> {
		validateUserId(userId);
		return this.storage.getFacts(userId);
	}

	/** Get valid facts for a user filtered by category */
	async getFactsByCategory(userId: string, category: FactCategory): Promise<SemanticFact[]> {
		validateUserId(userId);
		return this.storage.getFactsByCategory(userId, category);
	}

	/** Search facts by query */
	async search(userId: string, query: string, limit: number): Promise<SemanticFact[]> {
		validateUserId(userId);
		return this.storage.searchFacts(userId, query, limit);
	}

	/** Invalidate a fact (mark as no longer valid) */
	async invalidate(userId: string, factId: string, invalidAt: Date = new Date()): Promise<void> {
		validateUserId(userId);
		return this.storage.invalidateFact(userId, factId, invalidAt);
	}
}
