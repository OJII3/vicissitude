import { afterEach, describe, expect, mock, test } from "bun:test";

import type { Emotion } from "@vicissitude/shared/emotion";
import { NEUTRAL_EMOTION, createEmotion } from "@vicissitude/shared/emotion";
import type { MoodReader } from "@vicissitude/shared/ports";

import { MoodPresenceService, formatMoodStatus } from "../../apps/discord/src/mood-presence.ts";
import { createMockLogger } from "../test-helpers.ts";

// ─── Test Helpers ──────────────────────────────────────────────────

function createMockGateway() {
	return { setWatchingActivity: mock((_name: string) => {}) };
}

function createMockMoodReader(moodMap: Record<string, Emotion>): MoodReader {
	return {
		getMood: (agentId: string) => moodMap[agentId] ?? NEUTRAL_EMOTION,
	};
}

// ─── formatMoodStatus ──────────────────────────────────────────────

describe("formatMoodStatus", () => {
	test("happy な感情に対して黄色絵文字とカテゴリ名を返す", () => {
		const emotion = createEmotion(0.8, 0.6, 0.3);
		expect(formatMoodStatus(emotion)).toBe("🟡 happy");
	});

	test("relaxed な感情に対して緑色絵文字とカテゴリ名を返す", () => {
		const emotion = createEmotion(0.5, -0.4, 0.2);
		expect(formatMoodStatus(emotion)).toBe("🟢 relaxed");
	});

	test("neutral な感情に対して白色絵文字とカテゴリ名を返す", () => {
		expect(formatMoodStatus(NEUTRAL_EMOTION)).toBe("⚪ neutral");
	});

	test("surprised な感情に対して紫色絵文字とカテゴリ名を返す", () => {
		const emotion = createEmotion(0.0, 0.8, -0.5);
		expect(formatMoodStatus(emotion)).toBe("🟣 surprised");
	});

	test("angry な感情に対して赤色絵文字とカテゴリ名を返す", () => {
		const emotion = createEmotion(-0.7, 0.6, 0.4);
		expect(formatMoodStatus(emotion)).toBe("🔴 angry");
	});

	test("fear な感情に対してオレンジ色絵文字とカテゴリ名を返す", () => {
		const emotion = createEmotion(-0.6, 0.5, -0.3);
		expect(formatMoodStatus(emotion)).toBe("🟠 fear");
	});

	test("sad な感情に対して青色絵文字とカテゴリ名を返す", () => {
		const emotion = createEmotion(-0.6, -0.5, -0.2);
		expect(formatMoodStatus(emotion)).toBe("🔵 sad");
	});
});

// ─── MoodPresenceService.update() ──────────────────────────────────

describe("MoodPresenceService.update()", () => {
	test("MoodReader から感情を読み取り formatMoodStatus の結果を gateway に渡す", () => {
		const gateway = createMockGateway();
		const moodReader = createMockMoodReader({
			agent1: createEmotion(0.8, 0.6, 0.3),
		});
		const service = new MoodPresenceService(gateway, moodReader, createMockLogger(), {
			agentIds: ["agent1"],
		});

		service.update();

		expect(gateway.setWatchingActivity).toHaveBeenCalledWith("🟡 happy");
	});

	test("複数 agentIds のうち最初に見つかった非 neutral の感情を使う", () => {
		const gateway = createMockGateway();
		const moodReader = createMockMoodReader({
			agent1: NEUTRAL_EMOTION,
			agent2: createEmotion(-0.6, -0.5, -0.2),
			agent3: createEmotion(0.8, 0.6, 0.3),
		});
		const service = new MoodPresenceService(gateway, moodReader, createMockLogger(), {
			agentIds: ["agent1", "agent2", "agent3"],
		});

		service.update();

		expect(gateway.setWatchingActivity).toHaveBeenCalledWith("🔵 sad");
	});

	test("全ての agentId が neutral の場合は neutral を表示する", () => {
		const gateway = createMockGateway();
		const moodReader = createMockMoodReader({
			agent1: NEUTRAL_EMOTION,
			agent2: NEUTRAL_EMOTION,
		});
		const service = new MoodPresenceService(gateway, moodReader, createMockLogger(), {
			agentIds: ["agent1", "agent2"],
		});

		service.update();

		expect(gateway.setWatchingActivity).toHaveBeenCalledWith("⚪ neutral");
	});
});

// ─── MoodPresenceService.start() / stop() ──────────────────────────

describe("MoodPresenceService lifecycle", () => {
	let service: MoodPresenceService;

	afterEach(() => {
		service?.stop();
	});

	test("start() が即時に1回更新する", () => {
		const gateway = createMockGateway();
		const moodReader = createMockMoodReader({
			agent1: createEmotion(0.5, -0.4, 0.2),
		});
		service = new MoodPresenceService(gateway, moodReader, createMockLogger(), {
			agentIds: ["agent1"],
			intervalMs: 60_000,
		});

		service.start();

		expect(gateway.setWatchingActivity).toHaveBeenCalledTimes(1);
		expect(gateway.setWatchingActivity).toHaveBeenCalledWith("🟢 relaxed");
	});

	test("stop() 後はタイマーによる更新が止まる", async () => {
		const gateway = createMockGateway();
		const moodReader = createMockMoodReader({
			agent1: createEmotion(0.8, 0.6, 0.3),
		});
		service = new MoodPresenceService(gateway, moodReader, createMockLogger(), {
			agentIds: ["agent1"],
			intervalMs: 50,
		});

		service.start();
		expect(gateway.setWatchingActivity).toHaveBeenCalledTimes(1);

		service.stop();

		// stop 後に intervalMs 以上待っても追加呼び出しがないことを確認
		await new Promise((resolve) => {
			setTimeout(resolve, 120);
		});
		expect(gateway.setWatchingActivity).toHaveBeenCalledTimes(1);
	});
});
