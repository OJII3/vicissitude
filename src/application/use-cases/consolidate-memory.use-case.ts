import type { Logger } from "../../domain/ports/logger.port.ts";
import type { MemoryConsolidator } from "../../domain/ports/memory-consolidator.port.ts";

export class ConsolidateMemoryUseCase {
	constructor(
		private readonly consolidator: MemoryConsolidator,
		private readonly logger: Logger,
	) {}

	async execute(): Promise<void> {
		const guildIds = this.consolidator.getActiveGuildIds();
		if (guildIds.length === 0) {
			this.logger.info("[ltm-consolidation] アクティブなギルドなし、スキップ");
			return;
		}

		for (const guildId of guildIds) {
			try {
				/* oxlint-disable-next-line no-await-in-loop -- sequential: avoid DB write contention across guilds */
				const result = await this.consolidator.consolidate(guildId);
				if (result.processedEpisodes > 0) {
					this.logger.info(
						`[ltm-consolidation] guild=${guildId}: ${String(result.processedEpisodes)} episodes processed, new=${String(result.newFacts)} reinforce=${String(result.reinforced)} update=${String(result.updated)} invalidate=${String(result.invalidated)}`,
					);
				}
			} catch (err) {
				this.logger.error(`[ltm-consolidation] guild=${guildId} failed:`, err);
			}
		}
	}
}
