import type {
	EmotionProviderCooldown,
	EmotionProviderCooldownKey,
	EmotionProviderCooldownStore,
} from "@vicissitude/shared/ports";
import { and, eq } from "drizzle-orm";

import type { StoreDb } from "./db.ts";
import { emotionProviderCooldown } from "./schema.ts";

export class SqliteEmotionProviderCooldownStore implements EmotionProviderCooldownStore {
	constructor(private readonly db: StoreDb) {}

	getCooldown(key: EmotionProviderCooldownKey, nowMs: number): EmotionProviderCooldown | null {
		const row = this.db
			.select()
			.from(emotionProviderCooldown)
			.where(
				and(
					eq(emotionProviderCooldown.providerId, key.providerId),
					eq(emotionProviderCooldown.modelId, key.modelId),
				),
			)
			.get();

		if (!row) return null;
		if (row.untilMs <= nowMs) {
			this.db
				.delete(emotionProviderCooldown)
				.where(
					and(
						eq(emotionProviderCooldown.providerId, key.providerId),
						eq(emotionProviderCooldown.modelId, key.modelId),
					),
				)
				.run();
			return null;
		}

		return { untilMs: row.untilMs, reason: row.reason };
	}

	setCooldown(key: EmotionProviderCooldownKey, cooldown: EmotionProviderCooldown): void {
		this.db
			.insert(emotionProviderCooldown)
			.values({
				providerId: key.providerId,
				modelId: key.modelId,
				untilMs: cooldown.untilMs,
				reason: cooldown.reason,
				updatedAt: Date.now(),
			})
			.onConflictDoUpdate({
				target: [emotionProviderCooldown.providerId, emotionProviderCooldown.modelId],
				set: {
					untilMs: cooldown.untilMs,
					reason: cooldown.reason,
					updatedAt: Date.now(),
				},
			})
			.run();
	}
}
