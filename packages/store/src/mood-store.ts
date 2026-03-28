import { NEUTRAL_EMOTION } from "@vicissitude/shared/emotion";
import type { Emotion } from "@vicissitude/shared/emotion";
import type { MoodReader, MoodWriter } from "@vicissitude/shared/ports";
import { eq } from "drizzle-orm";

import type { StoreDb } from "./db.ts";
import { moodState } from "./schema.ts";

/** mood の有効期限（15分） */
export const MOOD_TTL_MS = 900_000;

export class SqliteMoodStore implements MoodReader, MoodWriter {
	constructor(private readonly db: StoreDb) {}

	getMood(agentId: string): Emotion {
		const row = this.db
			.select()
			.from(moodState)
			.where(eq(moodState.agentId, agentId))
			.get();

		if (!row) return NEUTRAL_EMOTION;
		if (Date.now() - row.updatedAt >= MOOD_TTL_MS) return NEUTRAL_EMOTION;

		return { valence: row.valence, arousal: row.arousal, dominance: row.dominance };
	}

	setMood(agentId: string, emotion: Emotion): void {
		this.db
			.insert(moodState)
			.values({
				agentId,
				valence: emotion.valence,
				arousal: emotion.arousal,
				dominance: emotion.dominance,
				updatedAt: Date.now(),
			})
			.onConflictDoUpdate({
				target: moodState.agentId,
				set: {
					valence: emotion.valence,
					arousal: emotion.arousal,
					dominance: emotion.dominance,
					updatedAt: Date.now(),
				},
			})
			.run();
	}
}
