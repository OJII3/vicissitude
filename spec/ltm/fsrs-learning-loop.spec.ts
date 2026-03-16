/* oxlint-disable no-non-null-assertion, require-await -- FSRS learning loop integration tests */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { EpisodicMemory } from "@vicissitude/ltm/episodic";
import { retrievability } from "@vicissitude/ltm/fsrs";
import { LtmStorage } from "@vicissitude/ltm/ltm-storage";
import { Retrieval } from "@vicissitude/ltm/retrieval";
import { createMockLLM, makeEpisode } from "./test-helpers.ts";

const userId = "user-1";

function mockLlm(embedding: number[]) {
	return createMockLLM({ embedding });
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

	test("retrieve fires review and updates lastReviewedAt asynchronously", async () => {
		const ep = makeEpisode({ title: "TypeScript Guide", embedding: [1, 0, 0] });
		await storage.saveEpisode(userId, ep);

		const before = await storage.getEpisodeById(userId, ep.id);
		expect(before!.lastReviewedAt).toBeNull();

		const now = new Date("2026-06-01T00:00:00Z");
		await retrieval.retrieve(userId, "TypeScript", { now });
		await retrieval.flushReviews();

		const after = await storage.getEpisodeById(userId, ep.id);
		expect(after!.lastReviewedAt).toEqual(now);
	});

	test("returned scores reflect pre-review state", async () => {
		const ep = makeEpisode({ title: "TypeScript Guide", embedding: [1, 0, 0] });
		await storage.saveEpisode(userId, ep);

		// Episode has null lastReviewedAt → retrievability = 1.0
		const now = new Date("2026-06-01T00:00:00Z");
		const result = await retrieval.retrieve(userId, "TypeScript", { now });

		expect(result.episodes[0]!.retrievability).toBe(1.0);

		// After flush, the DB state is updated but the returned result is unchanged
		await retrieval.flushReviews();
		const updated = await storage.getEpisodeById(userId, ep.id);
		expect(updated!.lastReviewedAt).toEqual(now);
		// The originally returned retrievability is still 1.0 (pre-review snapshot)
		expect(result.episodes[0]!.retrievability).toBe(1.0);
	});

	test("episode retrieved twice has more recent lastReviewedAt", async () => {
		const ep = makeEpisode({ title: "TypeScript Guide", embedding: [1, 0, 0] });
		await storage.saveEpisode(userId, ep);

		const t1 = new Date("2026-03-01T00:00:00Z");
		const t2 = new Date("2026-03-15T00:00:00Z");

		await retrieval.retrieve(userId, "TypeScript", { now: t1 });
		await retrieval.flushReviews();
		const afterFirst = await storage.getEpisodeById(userId, ep.id);
		expect(afterFirst!.lastReviewedAt).toEqual(t1);

		await retrieval.retrieve(userId, "TypeScript", { now: t2 });
		await retrieval.flushReviews();
		const afterSecond = await storage.getEpisodeById(userId, ep.id);
		expect(afterSecond!.lastReviewedAt).toEqual(t2);

		// More recent review → higher retrievability at a future point
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

		const ep = makeEpisode({ title: "TypeScript Bare", embedding: [1, 0, 0] });
		await storage.saveEpisode(userId, ep);

		const now = new Date("2026-06-01T00:00:00Z");
		await bareRetrieval.retrieve(userId, "TypeScript", { now });
		await bareRetrieval.flushReviews();

		const after = await storage.getEpisodeById(userId, ep.id);
		expect(after!.lastReviewedAt).toBeNull();
	});

	test("recently reviewed episode scores higher in search results", async () => {
		const now = new Date("2026-06-01T00:00:00Z");

		const epRecent = makeEpisode({ title: "TypeScript Recent", embedding: [1, 0, 0] });
		const epStale = makeEpisode({ title: "TypeScript Stale", embedding: [1, 0, 0] });
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
