import {
	addFactApplicationResult,
	ConsolidationFactApplier,
	emptyFactApplicationResult,
	type FactApplicationResult,
} from "./consolidation-action-applier.ts";
import { ConsolidationEpisodeFinalizer } from "./consolidation-episode-finalizer.ts";
import { ConsolidationExtractor } from "./consolidation-extractor.ts";
import type { Episode } from "./episode.ts";
import type { EpisodicMemory } from "./episodic.ts";
import type { MemoryLlmPort } from "./llm-port.ts";
import type { MemoryStorage } from "./storage.ts";
import { validateUserId } from "./utils.ts";

export type { ConsolidationOutput, ExtractedFact } from "./consolidation-contract.ts";
export { ConsolidationExtractor, selectExtractionStrategy } from "./consolidation-extractor.ts";

/** Result of a consolidation run */
export interface ConsolidationResult extends FactApplicationResult {
	processedEpisodes: number;
}

export type ConsolidationClock = () => Date;

/** Consolidation pipeline — converts episodes into semantic facts */
export class ConsolidationPipeline {
	private readonly extractor: ConsolidationExtractor;
	private readonly factApplier: ConsolidationFactApplier;
	private readonly episodeFinalizer: ConsolidationEpisodeFinalizer;

	constructor(
		llm: MemoryLlmPort,
		private readonly storage: MemoryStorage,
		episodic: EpisodicMemory | null = null,
		private readonly clock: ConsolidationClock = () => new Date(),
	) {
		this.extractor = new ConsolidationExtractor(llm);
		this.factApplier = new ConsolidationFactApplier(llm, storage);
		this.episodeFinalizer = new ConsolidationEpisodeFinalizer(storage, episodic);
	}

	/** Run consolidation for a user: extract facts from unconsolidated episodes */
	async consolidate(userId: string): Promise<ConsolidationResult> {
		validateUserId(userId);
		const episodes = await this.storage.getUnconsolidatedEpisodes(userId);
		const result = emptyResult();
		for (const episode of episodes) {
			// eslint-disable-next-line no-await-in-loop -- sequential: each episode depends on updated fact state
			await this.processEpisode(userId, episode, result);
		}
		return result;
	}

	/** Process a single episode: extract facts, apply actions, review FSRS, mark consolidated */
	private async processEpisode(
		userId: string,
		episode: Episode,
		result: ConsolidationResult,
	): Promise<void> {
		const existingFacts = await this.storage.getFacts(userId);
		const extracted = await this.extractor.extract(episode, existingFacts);
		const now = this.clock();
		const actionResult = await this.factApplier.apply(
			{ userId, episodeId: episode.id, existingFacts, now },
			extracted,
		);
		addFactApplicationResult(result, actionResult);
		await this.episodeFinalizer.finalize({ userId, episodeId: episode.id, now });
		result.processedEpisodes++;
	}
}

function emptyResult(): ConsolidationResult {
	return { processedEpisodes: 0, ...emptyFactApplicationResult() };
}
