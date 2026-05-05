import type { ConsolidationOutput, ExtractedFact } from "./consolidation-contract.ts";
import type { MemoryLlmPort } from "./llm-port.ts";
import { createFact } from "./semantic-fact.ts";
import type { SemanticFact } from "./semantic-fact.ts";
import type { MemoryStorage } from "./storage.ts";
import type { ConsolidationAction } from "./types.ts";
import { cosineSimilarity } from "./vector-math.ts";

export interface FactApplicationContext {
	userId: string;
	episodeId: string;
	existingFacts: SemanticFact[];
	now: Date;
}

export interface FactApplicationResult {
	newFacts: number;
	reinforced: number;
	updated: number;
	invalidated: number;
}

const DEDUPE_THRESHOLD = 0.95;
const DUPLICATE_CANDIDATE_LIMIT = 5;

export function emptyFactApplicationResult(): FactApplicationResult {
	return { newFacts: 0, reinforced: 0, updated: 0, invalidated: 0 };
}

export function addFactApplicationResult(
	target: FactApplicationResult,
	source: FactApplicationResult,
): void {
	target.newFacts += source.newFacts;
	target.reinforced += source.reinforced;
	target.updated += source.updated;
	target.invalidated += source.invalidated;
}

export class ConsolidationFactApplier {
	constructor(
		private readonly llm: MemoryLlmPort,
		private readonly storage: MemoryStorage,
	) {}

	async apply(
		ctx: FactApplicationContext,
		output: ConsolidationOutput,
	): Promise<FactApplicationResult> {
		const result = emptyFactApplicationResult();
		for (const extracted of output.facts) {
			// eslint-disable-next-line no-await-in-loop -- sequential writes preserve action order
			const actualAction = await this.dispatchAction(ctx, extracted);
			if (actualAction) {
				incrementResult(result, actualAction);
			}
		}
		return result;
	}

	private async dispatchAction(
		ctx: FactApplicationContext,
		extracted: ExtractedFact,
	): Promise<ConsolidationAction | null> {
		switch (extracted.action) {
			case "new": {
				return this.applyNew(ctx, extracted);
			}
			case "reinforce": {
				return (await this.applyReinforce(ctx, extracted)) ? "reinforce" : null;
			}
			case "update": {
				return (await this.applyUpdate(ctx, extracted)) ? "update" : null;
			}
			case "invalidate": {
				return (await this.applyInvalidate(ctx, extracted)) ? "invalidate" : null;
			}
		}
	}

	private async applyNew(
		ctx: FactApplicationContext,
		extracted: ExtractedFact,
	): Promise<ConsolidationAction> {
		const embedding = await this.llm.embed(extracted.fact);
		const duplicate = await this.findDuplicate(ctx.userId, embedding);
		if (duplicate) {
			await this.storage.updateFact(ctx.userId, duplicate.id, {
				sourceEpisodicIds: [...duplicate.sourceEpisodicIds, ctx.episodeId],
			});
			return "reinforce";
		}
		const fact = createFact({
			userId: ctx.userId,
			category: extracted.category,
			fact: extracted.fact,
			keywords: extracted.keywords,
			sourceEpisodicIds: [ctx.episodeId],
			embedding,
			now: ctx.now,
		});
		await this.storage.saveFact(ctx.userId, fact);
		return "new";
	}

	private async findDuplicate(userId: string, embedding: number[]): Promise<SemanticFact | null> {
		const candidates = await this.storage.searchFactsByEmbedding(
			userId,
			embedding,
			DUPLICATE_CANDIDATE_LIMIT,
		);
		for (const candidate of candidates) {
			if (cosineSimilarity(embedding, candidate.embedding) >= DEDUPE_THRESHOLD) {
				return candidate;
			}
		}
		return null;
	}

	private async applyReinforce(
		ctx: FactApplicationContext,
		extracted: ExtractedFact,
	): Promise<boolean> {
		if (!extracted.existingFactId) {
			return false;
		}
		const existing = ctx.existingFacts.find((f) => f.id === extracted.existingFactId);
		if (!existing) {
			return false;
		}
		await this.storage.updateFact(ctx.userId, extracted.existingFactId, {
			sourceEpisodicIds: [...existing.sourceEpisodicIds, ctx.episodeId],
		});
		return true;
	}

	private async applyUpdate(
		ctx: FactApplicationContext,
		extracted: ExtractedFact,
	): Promise<boolean> {
		if (extracted.existingFactId) {
			const existing = ctx.existingFacts.find((f) => f.id === extracted.existingFactId);
			if (!existing) {
				return false;
			}
			await this.storage.invalidateFact(ctx.userId, extracted.existingFactId, ctx.now);
		}
		await this.applyNew(ctx, extracted);
		return true;
	}

	private async applyInvalidate(
		ctx: FactApplicationContext,
		extracted: ExtractedFact,
	): Promise<boolean> {
		if (!extracted.existingFactId) {
			return false;
		}
		const existing = ctx.existingFacts.find((f) => f.id === extracted.existingFactId);
		if (!existing) {
			return false;
		}
		await this.storage.invalidateFact(ctx.userId, extracted.existingFactId, ctx.now);
		return true;
	}
}

const ACTION_TO_RESULT_KEY: Record<ConsolidationAction, keyof FactApplicationResult> = {
	new: "newFacts",
	reinforce: "reinforced",
	update: "updated",
	invalidate: "invalidated",
};

function incrementResult(result: FactApplicationResult, action: ConsolidationAction): void {
	result[ACTION_TO_RESULT_KEY[action]]++;
}
