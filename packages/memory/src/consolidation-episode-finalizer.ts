import type { EpisodicMemory } from "./episodic.ts";
import type { MemoryStorage } from "./storage.ts";

export interface EpisodeFinalizationContext {
	userId: string;
	episodeId: string;
	now: Date;
}

/** Side-effect boundary for completing an episode after fact application. */
export class ConsolidationEpisodeFinalizer {
	constructor(
		private readonly storage: MemoryStorage,
		private readonly episodic: EpisodicMemory | null,
	) {}

	async finalize(ctx: EpisodeFinalizationContext): Promise<void> {
		if (this.episodic) {
			await this.episodic.review(ctx.userId, ctx.episodeId, { rating: "good", now: ctx.now });
		}
		await this.storage.markEpisodeConsolidated(ctx.userId, ctx.episodeId, ctx.now);
	}
}
