import { describe, expect, mock, test } from "bun:test";

import { CriticAuditor } from "./critic-auditor.ts";
import type { DriftScore, DriftScoreCalculator } from "./drift-score.ts";
import type { Episode } from "./episode.ts";
import type { MemoryLlmPort, Schema } from "./llm-port.ts";
import { MemoryStorage } from "./storage.ts";
import type { ChatMessage } from "./types.ts";

const USER_ID = "1234567890";
const BOT_USER_ID = "9999999999";
const NOW_MS = Date.parse("2026-01-01T00:00:00Z");

function createEpisode(messages: ChatMessage[]): Episode {
	return {
		id: crypto.randomUUID(),
		userId: USER_ID,
		title: "episode",
		summary: "summary",
		messages,
		embedding: [0.1, 0.2, 0.3],
		surprise: 0.1,
		stability: 1,
		difficulty: 0.3,
		startAt: new Date(NOW_MS - 60_000),
		endAt: new Date(NOW_MS - 30_000),
		createdAt: new Date(NOW_MS - 60_000),
		lastReviewedAt: null,
		consolidatedAt: null,
	};
}

function createLlm(): MemoryLlmPort {
	return {
		chat: mock(() => Promise.resolve("ok")),
		chatStructured<T>(_messages: ChatMessage[], schema: Schema<T>): Promise<T> {
			return Promise.resolve(schema.parse({ severity: "none", summary: "ok" }));
		},
		embed: mock(() => Promise.resolve([0.1, 0.2, 0.3])),
	};
}

function createDriftCalculator(score: number) {
	const driftScore: DriftScore = {
		score,
		textFeatureScore: score,
		semanticScore: 0,
		features: {
			periodRate: 0,
			politeRate: 0,
			bannedPhraseCount: 0,
			empathyPhraseCount: 0,
			wrongPronounCount: 0,
			avgSentenceLength: 0,
			messageCount: 1,
		},
		computedAt: new Date(NOW_MS),
	};
	return {
		computeFromMessages: mock(() => Promise.resolve(driftScore)),
	} as unknown as DriftScoreCalculator & {
		computeFromMessages: ReturnType<typeof mock>;
	};
}

function createAuditor(storage: MemoryStorage, driftCalculator: DriftScoreCalculator) {
	return new CriticAuditor({
		llm: createLlm(),
		storage,
		driftCalculator,
		characterDefinition: "ふあ",
		botUserId: BOT_USER_ID,
		nowProvider: () => NOW_MS,
	});
}

describe("CriticAuditor skip observability", () => {
	test("bot authorId に一致する assistant メッセージがない場合は no_messages を返す", async () => {
		const storage = new MemoryStorage();
		const driftCalculator = createDriftCalculator(0.5);
		try {
			await storage.saveEpisode(
				USER_ID,
				createEpisode([{ role: "assistant", content: "hello", authorId: "other-bot" }]),
			);

			const result = await createAuditor(storage, driftCalculator).audit(USER_ID);

			expect(result).toEqual({ status: "skipped", reason: "no_messages" });
			expect(driftCalculator.computeFromMessages).not.toHaveBeenCalled();
		} finally {
			storage.close();
		}
	});

	test("低ドリフトかつエピソード数が少ない場合は low_drift と driftScore を返す", async () => {
		const storage = new MemoryStorage();
		const driftCalculator = createDriftCalculator(0.01);
		try {
			await storage.saveEpisode(
				USER_ID,
				createEpisode([{ role: "assistant", content: "うん", authorId: BOT_USER_ID }]),
			);

			const result = await createAuditor(storage, driftCalculator).audit(USER_ID);

			expect(result).toEqual({ status: "skipped", reason: "low_drift", driftScore: 0.01 });
			expect(driftCalculator.computeFromMessages).toHaveBeenCalledTimes(1);
		} finally {
			storage.close();
		}
	});
});
