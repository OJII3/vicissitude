/* oxlint-disable require-await -- methods are async for API compatibility */
import type { Episode } from "./episode.ts";
import type { FSRSCard } from "./fsrs.ts";
import { retrievability, reviewCard } from "./fsrs.ts";
import type { LtmStorage } from "./ltm-storage.ts";
import type { ReviewRating } from "./types.ts";
import { validateUserId } from "./utils.ts";

/** Options for reviewing an episode */
export interface ReviewOptions {
	rating: ReviewRating;
	now?: Date;
}

/** Episodic memory service — manages episode lifecycle */
export class EpisodicMemory {
	constructor(protected storage: LtmStorage) {}

	/** Get all episodes for a user */
	async getEpisodes(userId: string): Promise<Episode[]> {
		validateUserId(userId);
		return this.storage.getEpisodes(userId);
	}

	/** Get a single episode by ID */
	async getEpisodeById(userId: string, episodeId: string): Promise<Episode | null> {
		validateUserId(userId);
		return this.storage.getEpisodeById(userId, episodeId);
	}

	/** Get unconsolidated episodes for a user */
	async getUnconsolidated(userId: string): Promise<Episode[]> {
		validateUserId(userId);
		return this.storage.getUnconsolidatedEpisodes(userId);
	}

	/** Search episodes by query */
	async search(userId: string, query: string, limit: number): Promise<Episode[]> {
		validateUserId(userId);
		return this.storage.searchEpisodes(userId, query, limit);
	}

	/**
	 * Review an episode — update FSRS parameters based on rating.
	 * Called when a memory is retrieved and its relevance is evaluated.
	 */
	async review(
		userId: string,
		episodeId: string,
		options: ReviewOptions,
	): Promise<FSRSCard | null> {
		validateUserId(userId);
		const episode = await this.storage.getEpisodeById(userId, episodeId);
		if (!episode) {
			return null;
		}

		const card: FSRSCard = {
			stability: episode.stability,
			difficulty: episode.difficulty,
			lastReviewedAt: episode.lastReviewedAt,
		};

		const reviewTime = options.now ?? new Date();
		const updated = reviewCard(card, options.rating, reviewTime);
		await this.storage.updateEpisodeFSRS(userId, episodeId, updated);
		return updated;
	}

	/** Mark an episode as consolidated into semantic memory */
	async markConsolidated(userId: string, episodeId: string): Promise<void> {
		validateUserId(userId);
		return this.storage.markEpisodeConsolidated(userId, episodeId);
	}

	/** Calculate the current retrievability of an episode */
	getRetrievability(episode: Episode, now: Date = new Date()): number {
		return retrievability(
			{
				stability: episode.stability,
				difficulty: episode.difficulty,
				lastReviewedAt: episode.lastReviewedAt,
			},
			now,
		);
	}
}
