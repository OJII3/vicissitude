import { describe, expect, it } from "bun:test";

import { SqliteEmotionProviderCooldownStore } from "@vicissitude/store/emotion-provider-cooldown-store";
import { createTestDb } from "@vicissitude/store/test-helpers";

describe("SqliteEmotionProviderCooldownStore", () => {
	it("provider/model ごとに cooldown を保存して取得できる", () => {
		const db = createTestDb();
		const store = new SqliteEmotionProviderCooldownStore(db);
		const key = { providerId: "github-copilot", modelId: "gpt-5-mini" };

		store.setCooldown(key, { untilMs: 70_000, reason: "quota_exceeded" });

		expect(store.getCooldown(key, 10_000)).toEqual({
			untilMs: 70_000,
			reason: "quota_exceeded",
		});
	});

	it("provider/model が異なる cooldown は共有しない", () => {
		const db = createTestDb();
		const store = new SqliteEmotionProviderCooldownStore(db);

		store.setCooldown(
			{ providerId: "github-copilot", modelId: "gpt-5-mini" },
			{ untilMs: 70_000, reason: "quota_exceeded" },
		);

		expect(
			store.getCooldown({ providerId: "github-copilot", modelId: "gpt-5" }, 10_000),
		).toBeNull();
		expect(store.getCooldown({ providerId: "openai", modelId: "gpt-5-mini" }, 10_000)).toBeNull();
	});

	it("期限切れ cooldown は削除して null を返す", () => {
		const db = createTestDb();
		const store = new SqliteEmotionProviderCooldownStore(db);
		const key = { providerId: "github-copilot", modelId: "gpt-5-mini" };

		store.setCooldown(key, { untilMs: 70_000, reason: "quota_exceeded" });

		expect(store.getCooldown(key, 70_000)).toBeNull();
		expect(
			db.$client.prepare("SELECT COUNT(*) AS count FROM emotion_provider_cooldown").get() as {
				count: number;
			},
		).toEqual({ count: 0 });
	});
});
