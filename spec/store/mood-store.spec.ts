import { describe, expect, it } from "bun:test";

import { NEUTRAL_EMOTION, createEmotion } from "@vicissitude/shared/emotion";
import type { MoodReader, MoodWriter } from "@vicissitude/shared/ports";
import { createTestDb } from "@vicissitude/store/test-helpers";

// SqliteMoodStore は MoodReader & MoodWriter を実装する想定。
// テストでは実装クラスをインポートして検証する。
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type SqliteMoodStoreModule = { SqliteMoodStore: new (...args: unknown[]) => MoodReader & MoodWriter };

async function importMoodStore(): Promise<SqliteMoodStoreModule> {
	return (await import("@vicissitude/store/mood-store")) as SqliteMoodStoreModule;
}

describe("SqliteMoodStore", () => {
	it("未設定の agentId は NEUTRAL_EMOTION を返す", async () => {
		const { SqliteMoodStore } = await importMoodStore();
		const db = createTestDb();
		const store = new SqliteMoodStore(db);

		const mood = store.getMood("agent-unknown");

		expect(mood.valence).toBe(NEUTRAL_EMOTION.valence);
		expect(mood.arousal).toBe(NEUTRAL_EMOTION.arousal);
		expect(mood.dominance).toBe(NEUTRAL_EMOTION.dominance);
	});

	it("setMood で設定した値が getMood で取得できる", async () => {
		const { SqliteMoodStore } = await importMoodStore();
		const db = createTestDb();
		const store = new SqliteMoodStore(db);
		const emotion = createEmotion(0.5, -0.3, 0.7);

		store.setMood("agent-1", emotion);
		const mood = store.getMood("agent-1");

		expect(mood.valence).toBeCloseTo(0.5);
		expect(mood.arousal).toBeCloseTo(-0.3);
		expect(mood.dominance).toBeCloseTo(0.7);
	});

	it("setMood で上書きすると最新の値が返る", async () => {
		const { SqliteMoodStore } = await importMoodStore();
		const db = createTestDb();
		const store = new SqliteMoodStore(db);

		store.setMood("agent-1", createEmotion(0.1, 0.2, 0.3));
		store.setMood("agent-1", createEmotion(-0.5, 0.8, -0.2));
		const mood = store.getMood("agent-1");

		expect(mood.valence).toBeCloseTo(-0.5);
		expect(mood.arousal).toBeCloseTo(0.8);
		expect(mood.dominance).toBeCloseTo(-0.2);
	});

	it("有効期限切れ（15分以上前）なら NEUTRAL_EMOTION を返す", async () => {
		const { SqliteMoodStore } = await importMoodStore();
		const db = createTestDb();
		const store = new SqliteMoodStore(db);

		store.setMood("agent-1", createEmotion(0.9, 0.9, 0.9));

		// updated_at を 16 分前に巻き戻す（内部テーブルを直接操作）
		const sixteenMinutesAgo = Date.now() - 16 * 60 * 1000;
		db.run(
			// biome-ignore lint: raw SQL for test setup
			`UPDATE mood_state SET updated_at = ${sixteenMinutesAgo} WHERE agent_id = 'agent-1'` as never,
		);

		const mood = store.getMood("agent-1");

		expect(mood.valence).toBe(NEUTRAL_EMOTION.valence);
		expect(mood.arousal).toBe(NEUTRAL_EMOTION.arousal);
		expect(mood.dominance).toBe(NEUTRAL_EMOTION.dominance);
	});

	it("有効期限内（15分未満）なら設定値を返す", async () => {
		const { SqliteMoodStore } = await importMoodStore();
		const db = createTestDb();
		const store = new SqliteMoodStore(db);
		const emotion = createEmotion(0.6, -0.4, 0.2);

		store.setMood("agent-1", emotion);
		const mood = store.getMood("agent-1");

		expect(mood.valence).toBeCloseTo(0.6);
		expect(mood.arousal).toBeCloseTo(-0.4);
		expect(mood.dominance).toBeCloseTo(0.2);
	});

	it("異なる agentId は互いに独立している", async () => {
		const { SqliteMoodStore } = await importMoodStore();
		const db = createTestDb();
		const store = new SqliteMoodStore(db);

		store.setMood("agent-1", createEmotion(0.5, 0.5, 0.5));
		store.setMood("agent-2", createEmotion(-0.5, -0.5, -0.5));

		const mood1 = store.getMood("agent-1");
		const mood2 = store.getMood("agent-2");

		expect(mood1.valence).toBeCloseTo(0.5);
		expect(mood2.valence).toBeCloseTo(-0.5);
	});

	it("範囲外の VAD 値は [-1, 1] にクランプされる", async () => {
		const { SqliteMoodStore } = await importMoodStore();
		const db = createTestDb();
		const store = new SqliteMoodStore(db);

		// createEmotion が clamp するため、store 経由でも clamp された値が保存される
		const emotion = createEmotion(2.0, -3.0, 1.5);
		store.setMood("agent-1", emotion);
		const mood = store.getMood("agent-1");

		expect(mood.valence).toBe(1);
		expect(mood.arousal).toBe(-1);
		expect(mood.dominance).toBe(1);
	});
});
