import {
	addFactApplicationResult,
	ConsolidationFactApplier,
	emptyFactApplicationResult,
	type FactApplicationResult,
} from "./consolidation-action-applier.ts";
import { consolidationSchema, type ConsolidationOutput } from "./consolidation-contract.ts";
import {
	buildCalibrationMessages,
	buildExtractionMessages,
	buildPredictionMessages,
} from "./consolidation-prompts.ts";
import type { Episode } from "./episode.ts";
import type { EpisodicMemory } from "./episodic.ts";
import type { MemoryLlmPort } from "./llm-port.ts";
import type { SemanticFact } from "./semantic-fact.ts";
import type { MemoryStorage } from "./storage.ts";
import { validateUserId } from "./utils.ts";

export type { ConsolidationOutput, ExtractedFact } from "./consolidation-contract.ts";

/** Result of a consolidation run */
export interface ConsolidationResult extends FactApplicationResult {
	processedEpisodes: number;
}

/** Consolidation pipeline — converts episodes into semantic facts */
export class ConsolidationPipeline {
	private readonly factApplier: ConsolidationFactApplier;

	constructor(
		protected llm: MemoryLlmPort,
		protected storage: MemoryStorage,
		private episodic: EpisodicMemory | null = null,
	) {
		this.factApplier = new ConsolidationFactApplier(llm, storage);
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
		const extracted = await this.extractForEpisode(episode, existingFacts);
		const now = new Date();
		const actionResult = await this.factApplier.apply(
			{ userId, episodeId: episode.id, existingFacts, now },
			extracted,
		);
		addFactApplicationResult(result, actionResult);
		if (this.episodic) {
			await this.episodic.review(userId, episode.id, { rating: "good", now });
		}
		await this.storage.markEpisodeConsolidated(userId, episode.id);
		result.processedEpisodes++;
	}

	private extractForEpisode(
		episode: Episode,
		existingFacts: SemanticFact[],
	): Promise<ConsolidationOutput> {
		return existingFacts.length > 0
			? this.predictCalibrate(episode, existingFacts)
			: this.extractFacts(episode, existingFacts);
	}

	/** Use LLM to extract facts from a single episode */
	private extractFacts(
		episode: Episode,
		existingFacts: SemanticFact[],
	): Promise<ConsolidationOutput> {
		return this.llm.chatStructured<ConsolidationOutput>(
			buildExtractionMessages(episode, existingFacts),
			consolidationSchema,
		);
	}

	/** PCL: predict then calibrate, with fallback to direct extraction */
	private async predictCalibrate(
		episode: Episode,
		existingFacts: SemanticFact[],
	): Promise<ConsolidationOutput> {
		let prediction: string;
		try {
			prediction = await this.predict(episode, existingFacts);
		} catch {
			return this.extractFacts(episode, existingFacts);
		}
		return this.calibrate(episode, prediction, existingFacts);
	}

	/** PREDICT phase: generate prediction text from existing facts + episode title + summary */
	private predict(episode: Episode, existingFacts: SemanticFact[]): Promise<string> {
		return this.llm.chat(buildPredictionMessages(episode, existingFacts));
	}

	/** CALIBRATE phase: extract facts by comparing prediction with actual episode */
	private calibrate(
		episode: Episode,
		prediction: string,
		existingFacts: SemanticFact[],
	): Promise<ConsolidationOutput> {
		return this.llm.chatStructured<ConsolidationOutput>(
			buildCalibrationMessages(episode, prediction, existingFacts),
			consolidationSchema,
		);
	}
}

function emptyResult(): ConsolidationResult {
	return { processedEpisodes: 0, ...emptyFactApplicationResult() };
}
