import type { EpisodicMemory } from "./episodic.ts";
import type { ScoredEpisode } from "./retrieval.ts";
import { validateUserId } from "./utils.ts";

/** Options for explicitly reviewing episodes returned by retrieval */
export interface RetrievalReviewOptions {
	/** Current time — injectable for testing (default new Date()) */
	now?: Date;
	/** Max retrieved episodes to review (default 20, capped at 20) */
	maxEpisodes?: number;
}

const DEFAULT_MAX_EPISODES = 20;

function resolveReviewLimit(rawLimit: number | undefined): number {
	const limit = rawLimit ?? DEFAULT_MAX_EPISODES;
	return Math.max(0, Math.min(Math.floor(limit), DEFAULT_MAX_EPISODES));
}

/** Explicit command for recording that retrieved episodes were reviewed as relevant */
export class RetrievalReviewCommand {
	static readonly DEFAULT_MAX_EPISODES = DEFAULT_MAX_EPISODES;

	constructor(private episodic: EpisodicMemory) {}

	/** Review retrieved episodes to update FSRS parameters (search hit = "good") */
	async reviewRetrievedEpisodes(
		userId: string,
		episodes: readonly ScoredEpisode[],
		options: RetrievalReviewOptions = {},
	): Promise<number> {
		validateUserId(userId);
		const now = options.now ?? new Date();
		const maxEpisodes = resolveReviewLimit(options.maxEpisodes);
		const reviewed = await Promise.all(
			episodes
				.slice(0, maxEpisodes)
				.map((ep) => this.episodic.review(userId, ep.episode.id, { rating: "good", now })),
		);
		return reviewed.filter((card) => card !== null).length;
	}
}
