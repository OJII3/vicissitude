/* oxlint-disable no-non-null-assertion, require-await -- FSRS learning loop integration tests */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { EpisodicMemory } from "@vicissitude/memory/episodic";
import { retrievability } from "@vicissitude/memory/fsrs";
import { Retrieval, RetrievalReviewCommand } from "@vicissitude/memory/retrieval";
import { MemoryStorage } from "@vicissitude/memory/storage";

import { createMockLLM, makeEpisode } from "./test-helpers.ts";

const userId = "user-1";

function mockLlm(embedding: number[]) {
	return createMockLLM({ embedding });
}

describe("FSRS learning loop — explicit retrieval review command", () => {
	let storage: MemoryStorage;
	let episodic: EpisodicMemory;
	let retrieval: Retrieval;
	let retrievalReview: RetrievalReviewCommand;

	beforeEach(() => {
		storage = new MemoryStorage(":memory:");
		episodic = new EpisodicMemory(storage);
		retrieval = new Retrieval(mockLlm([1, 0, 0]), storage);
		retrievalReview = new RetrievalReviewCommand(episodic);
	});

	afterEach(() => {
		storage.close();
	});

	test("retrieve is a pure read and does not update lastReviewedAt", async () => {
		const ep = makeEpisode({ title: "TypeScript Guide", embedding: [1, 0, 0] });
		await storage.saveEpisode(userId, ep);

		const before = await storage.getEpisodeById(userId, ep.id);
		expect(before!.lastReviewedAt).toBeNull();

		const now = new Date("2026-06-01T00:00:00Z");
		await retrieval.retrieve(userId, "TypeScript", { now });

		const after = await storage.getEpisodeById(userId, ep.id);
		expect(after!.lastReviewedAt).toBeNull();
	});

	test("retrieve remains read-only even when an episodic dependency is available", async () => {
		const retrievalWithEpisodic = new Retrieval(mockLlm([1, 0, 0]), storage, episodic);
		const ep = makeEpisode({ title: "TypeScript Guide", embedding: [1, 0, 0] });
		await storage.saveEpisode(userId, ep);

		const now = new Date("2026-06-01T00:00:00Z");
		await retrievalWithEpisodic.retrieve(userId, "TypeScript", { now });
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 0);
		});

		const after = await storage.getEpisodeById(userId, ep.id);
		expect(after!.lastReviewedAt).toBeNull();
	});

	test("review command updates lastReviewedAt for retrieved episodes", async () => {
		const ep = makeEpisode({ title: "TypeScript Guide", embedding: [1, 0, 0] });
		await storage.saveEpisode(userId, ep);

		const now = new Date("2026-06-01T00:00:00Z");
		const result = await retrieval.retrieve(userId, "TypeScript", { now });
		const reviewed = await retrievalReview.reviewRetrievedEpisodes(userId, result.episodes, {
			now,
		});

		const updated = await storage.getEpisodeById(userId, ep.id);
		expect(reviewed).toBe(1);
		expect(updated!.lastReviewedAt).toEqual(now);
	});

	test("returned scores remain a read snapshot after explicit review", async () => {
		const ep = makeEpisode({ title: "TypeScript Guide", embedding: [1, 0, 0] });
		await storage.saveEpisode(userId, ep);

		const now = new Date("2026-06-01T00:00:00Z");
		const result = await retrieval.retrieve(userId, "TypeScript", { now });

		expect(result.episodes[0]!.retrievability).toBe(1.0);

		await retrievalReview.reviewRetrievedEpisodes(userId, result.episodes, { now });
		const updated = await storage.getEpisodeById(userId, ep.id);
		expect(updated!.lastReviewedAt).toEqual(now);
		expect(result.episodes[0]!.retrievability).toBe(1.0);
	});

	test("episode reviewed twice through the command has more recent lastReviewedAt", async () => {
		const ep = makeEpisode({ title: "TypeScript Guide", embedding: [1, 0, 0] });
		await storage.saveEpisode(userId, ep);

		const t1 = new Date("2026-03-01T00:00:00Z");
		const t2 = new Date("2026-03-15T00:00:00Z");

		const firstResult = await retrieval.retrieve(userId, "TypeScript", { now: t1 });
		await retrievalReview.reviewRetrievedEpisodes(userId, firstResult.episodes, { now: t1 });
		const afterFirst = await storage.getEpisodeById(userId, ep.id);
		expect(afterFirst!.lastReviewedAt).toEqual(t1);

		const secondResult = await retrieval.retrieve(userId, "TypeScript", { now: t2 });
		await retrievalReview.reviewRetrievedEpisodes(userId, secondResult.episodes, { now: t2 });
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

	test("review command ignores unknown episodes", async () => {
		const now = new Date("2026-06-01T00:00:00Z");
		const missingEpisode = { ...makeEpisode(), id: "missing-episode" };
		const reviewed = await retrievalReview.reviewRetrievedEpisodes(
			userId,
			[{ episode: missingEpisode, score: 1, retrievability: 1 }],
			{ now },
		);

		expect(reviewed).toBe(0);
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
