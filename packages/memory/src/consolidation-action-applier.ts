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

interface ResolvedFactApplicationContext extends FactApplicationContext {
	activeFactsById: Map<string, SemanticFact>;
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
		const resolvedCtx = {
			...ctx,
			activeFactsById: new Map(ctx.existingFacts.map((fact) => [fact.id, fact])),
		};
		const result = emptyFactApplicationResult();
		for (const extracted of output.facts) {
			// eslint-disable-next-line no-await-in-loop -- sequential writes preserve action order
			const actualAction = await this.dispatchAction(resolvedCtx, extracted);
			incrementResult(result, actualAction);
		}
		return result;
	}

	private async dispatchAction(
		ctx: ResolvedFactApplicationContext,
		extracted: ExtractedFact,
	): Promise<ConsolidationAction> {
		switch (extracted.action) {
			case "new": {
				return this.applyNew(ctx, extracted);
			}
			case "reinforce": {
				await this.applyReinforce(ctx, extracted);
				return "reinforce";
			}
			case "update": {
				await this.applyUpdate(ctx, extracted);
				return "update";
			}
			case "invalidate": {
				await this.applyInvalidate(ctx, extracted);
				return "invalidate";
			}
		}
	}

	private async applyNew(
		ctx: ResolvedFactApplicationContext,
		extracted: ExtractedFact,
	): Promise<ConsolidationAction> {
		const embedding = await this.llm.embed(extracted.fact);
		const duplicate = await this.findDuplicate(ctx.userId, embedding);
		if (duplicate) {
			const reinforced = {
				...duplicate,
				sourceEpisodicIds: appendSourceEpisode(duplicate, ctx.episodeId),
			};
			await this.storage.updateFact(ctx.userId, duplicate.id, reinforced);
			ctx.activeFactsById.set(duplicate.id, reinforced);
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
		ctx.activeFactsById.set(fact.id, fact);
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
		ctx: ResolvedFactApplicationContext,
		extracted: ExtractedFact & { action: "reinforce" },
	): Promise<void> {
		const existing = this.requireExistingFact(ctx, extracted.existingFactId, extracted.action);
		const reinforced = {
			...existing,
			sourceEpisodicIds: appendSourceEpisode(existing, ctx.episodeId),
		};
		await this.storage.updateFact(ctx.userId, extracted.existingFactId, reinforced);
		ctx.activeFactsById.set(extracted.existingFactId, reinforced);
	}

	private async applyUpdate(
		ctx: ResolvedFactApplicationContext,
		extracted: ExtractedFact & { action: "update" },
	): Promise<void> {
		this.requireExistingFact(ctx, extracted.existingFactId, extracted.action);
		await this.storage.invalidateFact(ctx.userId, extracted.existingFactId, ctx.now);
		ctx.activeFactsById.delete(extracted.existingFactId);
		await this.applyNew(ctx, extracted);
	}

	private async applyInvalidate(
		ctx: ResolvedFactApplicationContext,
		extracted: ExtractedFact & { action: "invalidate" },
	): Promise<void> {
		this.requireExistingFact(ctx, extracted.existingFactId, extracted.action);
		await this.storage.invalidateFact(ctx.userId, extracted.existingFactId, ctx.now);
		ctx.activeFactsById.delete(extracted.existingFactId);
	}

	private requireExistingFact(
		ctx: ResolvedFactApplicationContext,
		factId: string,
		action: ConsolidationAction,
	): SemanticFact {
		const existing = ctx.activeFactsById.get(factId);
		if (!existing) {
			throw new Error(
				`consolidation action "${action}" references inactive or unknown fact: ${factId}`,
			);
		}
		return existing;
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

function appendSourceEpisode(fact: SemanticFact, episodeId: string): string[] {
	return fact.sourceEpisodicIds.includes(episodeId)
		? fact.sourceEpisodicIds
		: [...fact.sourceEpisodicIds, episodeId];
}
