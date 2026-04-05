import type { SemanticFact } from "@vicissitude/memory/semantic-fact";
import type { MemoryStorage } from "@vicissitude/memory/storage";
import { HUA_SELF_SUBJECT } from "@vicissitude/shared/namespace";

import type { ListeningMemoryPort, ListeningRecord } from "./types.ts";

export interface Embedder {
	embed(text: string): Promise<number[]>;
}

export class ListeningMemory implements ListeningMemoryPort {
	constructor(
		private readonly storage: MemoryStorage,
		private readonly embedder: Embedder,
	) {}

	async saveListening(record: ListeningRecord): Promise<SemanticFact> {
		const factText = `${record.track.artistName} の『${record.track.name}』を聴いた。${record.impression}`;
		const embedding = await this.embedder.embed(factText);
		const fact: SemanticFact = {
			id: crypto.randomUUID(),
			userId: HUA_SELF_SUBJECT,
			category: "experience",
			fact: factText,
			keywords: [record.track.name, record.track.artistName],
			sourceEpisodicIds: [],
			embedding,
			validAt: record.listenedAt,
			invalidAt: null,
			createdAt: record.listenedAt,
		};
		await this.storage.saveFact(HUA_SELF_SUBJECT, fact);
		return fact;
	}
}
