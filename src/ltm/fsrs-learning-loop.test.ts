/* oxlint-disable no-non-null-assertion, require-await -- FSRS learning loop integration tests */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createEpisode } from "./episode.ts";
import { EpisodicMemory } from "./episodic.ts";
import { retrievability } from "./fsrs.ts";
import type { LtmLlmPort } from "./llm-port.ts";
import { LtmStorage } from "./ltm-storage.ts";
import { Retrieval } from "./retrieval.ts";
import type { ChatMessage } from "./types.ts";

const userId = "user-1";

function mockLlm(embedding: number[]): LtmLlmPort {
	return {
		chat: async () => "",
		chatStructured: async <T>(_: ChatMessage[], schema: { parse: (d: unknown) => T }) =>
			schema.parse({}),
		embed: async () => embedding,
	};
}

function makeEpisode(overrides: Record<string, unknown> = {}) {
	return createEpisode({
		userId,
		title: "Test Episode",
		summary: "A summary",
		messages: [{ role: "user", content: "hello" }] as ChatMessage[],
		embedding: [1, 0, 0],
		surprise: 0.5,
		startAt: new Date("2026-01-01T00:00:00Z"),
		endAt: new Date("2026-01-01T01:00:00Z"),
		...overrides,
	});
}

describe("FSRS learning loop — retrieve auto-review", () => {
	let storage: LtmStorage;
	let episodic: EpisodicMemory;
	let retrieval: Retrieval;

	beforeEach(() => {
		storage = new LtmStorage(":memory:");
		episodic = new EpisodicMemory(storage);
		retrieval = new Retrieval(mockLlm([1, 0, 0]), storage, episodic);
	});

	afterEach(() => {
		storage.close();
	});

	test("retrieve updates lastReviewedAt on matched episodes", async () => {
		const ep = makeEpisode({ title: "TypeScript Guide" });
		await storage.saveEpisode(userId, ep);

		// Before retrieve: lastReviewedAt is null
		const before = await storage.getEpisodeById(userId, ep.id);
		expect(before!.lastReviewedAt).toBeNull();

		const now = new Date("2026-06-01T00:00:00Z");
		await retrieval.retrieve(userId, "TypeScript", { now });

		// After retrieve: lastReviewedAt should be updated
		const after = await storage.getEpisodeById(userId, ep.id);
		expect(after!.lastReviewedAt).toEqual(now);
	});

	test("episode retrieved twice has more recent lastReviewedAt than single retrieve", async () => {
		const ep = makeEpisode({ title: "TypeScript Guide" });
		await storage.saveEpisode(userId, ep);

		const t1 = new Date("2026-03-01T00:00:00Z");
		const t2 = new Date("2026-03-15T00:00:00Z");

		await retrieval.retrieve(userId, "TypeScript", { now: t1 });
		const afterFirst = await storage.getEpisodeById(userId, ep.id);
		expect(afterFirst!.lastReviewedAt).toEqual(t1);

		await retrieval.retrieve(userId, "TypeScript", { now: t2 });
		const afterSecond = await storage.getEpisodeById(userId, ep.id);
		expect(afterSecond!.lastReviewedAt).toEqual(t2);

		// At a future time, the second review makes retrievability higher
		// because elapsed time from lastReviewedAt is shorter
		const futureTime = new Date("2026-04-01T00:00:00Z");
		const rAfterFirst = retrievability(
			{ stability: afterFirst!.stability, difficulty: afterFirst!.difficulty, lastReviewedAt: t1 },
			futureTime,
		);
		const rAfterSecond = retrievability(
			{
				stability: afterSecond!.stability,
				difficulty: afterSecond!.difficulty,
				lastReviewedAt: t2,
			},
			futureTime,
		);

		expect(rAfterSecond).toBeGreaterThan(rAfterFirst);
	});

	test("without episodic, retrieve does not update FSRS", async () => {
		const bareRetrieval = new Retrieval(mockLlm([1, 0, 0]), storage);

		const ep = makeEpisode({ title: "TypeScript Bare" });
		await storage.saveEpisode(userId, ep);

		const now = new Date("2026-06-01T00:00:00Z");
		await bareRetrieval.retrieve(userId, "TypeScript", { now });

		const after = await storage.getEpisodeById(userId, ep.id);
		expect(after!.lastReviewedAt).toBeNull();
	});

	test("recently reviewed episode scores higher in search results", async () => {
		const now = new Date("2026-06-01T00:00:00Z");

		// Both episodes have same text relevance
		const epRecent = makeEpisode({ title: "TypeScript Recent" });
		const epStale = makeEpisode({ title: "TypeScript Stale" });
		await storage.saveEpisode(userId, epRecent);
		await storage.saveEpisode(userId, epStale);

		// Simulate: epRecent was reviewed recently, epStale long ago
		await storage.updateEpisodeFSRS(userId, epRecent.id, {
			stability: 1.0,
			difficulty: 0.3,
			lastReviewedAt: new Date("2026-05-31T00:00:00Z"),
		});
		await storage.updateEpisodeFSRS(userId, epStale.id, {
			stability: 1.0,
			difficulty: 0.3,
			lastReviewedAt: new Date("2026-01-01T00:00:00Z"),
		});

		const result = await retrieval.retrieve(userId, "TypeScript", { now });
		expect(result.episodes.length).toBeGreaterThanOrEqual(2);

		const recentScore = result.episodes.find((e) => e.episode.id === epRecent.id)!.score;
		const staleScore = result.episodes.find((e) => e.episode.id === epStale.id)!.score;
		expect(recentScore).toBeGreaterThan(staleScore);
	});
});
