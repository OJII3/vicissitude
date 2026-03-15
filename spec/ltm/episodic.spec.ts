/* oxlint-disable no-non-null-assertion, require-await -- test assertions */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Episode } from "../../src/ltm/episode.ts";
import { createEpisode } from "../../src/ltm/episode.ts";
import { EpisodicMemory } from "../../src/ltm/episodic.ts";
import { LtmStorage } from "../../src/ltm/ltm-storage.ts";
import type { ChatMessage } from "../../src/ltm/types.ts";

const userId = "user-1";

function makeEpisode(overrides: Record<string, unknown> = {}): Episode {
	return createEpisode({
		userId,
		title: "Test Episode",
		summary: "A test summary",
		messages: [{ role: "user", content: "hello" }] as ChatMessage[],
		embedding: [0.1, 0.2],
		surprise: 0.5,
		startAt: new Date("2026-01-01T00:00:00Z"),
		endAt: new Date("2026-01-01T01:00:00Z"),
		...overrides,
	});
}

describe("EpisodicMemory — retrieval", () => {
	let storage: LtmStorage;
	let episodic: EpisodicMemory;

	beforeEach(() => {
		storage = new LtmStorage(":memory:");
		episodic = new EpisodicMemory(storage);
	});

	afterEach(() => {
		storage.close();
	});

	test("getEpisodes returns all episodes for a user", async () => {
		const ep1 = makeEpisode();
		const ep2 = makeEpisode({ title: "Second" });
		await storage.saveEpisode(userId, ep1);
		await storage.saveEpisode(userId, ep2);

		const episodes = await episodic.getEpisodes(userId);
		expect(episodes).toHaveLength(2);
	});

	test("getEpisodeById returns the episode", async () => {
		const ep = makeEpisode();
		await storage.saveEpisode(userId, ep);

		const found = await episodic.getEpisodeById(userId, ep.id);
		expect(found).not.toBeNull();
		expect(found!.id).toBe(ep.id);
	});

	test("getEpisodeById returns null for unknown id", async () => {
		const found = await episodic.getEpisodeById(userId, "nonexistent");
		expect(found).toBeNull();
	});

	test("getUnconsolidated returns only unconsolidated episodes", async () => {
		const ep1 = makeEpisode();
		const ep2 = makeEpisode();
		await storage.saveEpisode(userId, ep1);
		await storage.saveEpisode(userId, ep2);
		await storage.markEpisodeConsolidated(userId, ep1.id);

		const unconsolidated = await episodic.getUnconsolidated(userId);
		expect(unconsolidated).toHaveLength(1);
		expect(unconsolidated[0]!.id).toBe(ep2.id);
	});
});

describe("EpisodicMemory — search", () => {
	let storage: LtmStorage;
	let episodic: EpisodicMemory;

	beforeEach(() => {
		storage = new LtmStorage(":memory:");
		episodic = new EpisodicMemory(storage);
	});

	afterEach(() => {
		storage.close();
	});

	test("search finds episodes by title", async () => {
		const ep = makeEpisode({ title: "TypeScript Discussion" });
		await storage.saveEpisode(userId, ep);

		const results = await episodic.search(userId, "typescript", 10);
		expect(results).toHaveLength(1);
	});

	test("search finds episodes by summary", async () => {
		const ep = makeEpisode({ summary: "Talked about Bun runtime" });
		await storage.saveEpisode(userId, ep);

		const results = await episodic.search(userId, "bun", 10);
		expect(results).toHaveLength(1);
	});

	test("search respects limit", async () => {
		await Promise.all(
			Array.from({ length: 5 }, (_, i) =>
				storage.saveEpisode(userId, makeEpisode({ title: `Episode ${i}` })),
			),
		);

		const results = await episodic.search(userId, "episode", 3);
		expect(results).toHaveLength(3);
	});
});

describe("EpisodicMemory — FSRS review", () => {
	let storage: LtmStorage;
	let episodic: EpisodicMemory;

	beforeEach(() => {
		storage = new LtmStorage(":memory:");
		episodic = new EpisodicMemory(storage);
	});

	afterEach(() => {
		storage.close();
	});

	test("review updates FSRS parameters", async () => {
		const ep = makeEpisode();
		await storage.saveEpisode(userId, ep);

		const now = new Date();
		const updated = await episodic.review(userId, ep.id, { rating: "good", now });

		expect(updated).not.toBeNull();
		expect(updated!.lastReviewedAt).toEqual(now);
	});

	test("review with 'easy' increases stability", async () => {
		const ep = makeEpisode();
		await storage.saveEpisode(userId, ep);

		const reviewTime1 = new Date("2026-01-01T00:00:00Z");
		await episodic.review(userId, ep.id, { rating: "good", now: reviewTime1 });

		const reviewTime2 = new Date("2026-01-02T00:00:00Z");
		const updated = await episodic.review(userId, ep.id, { rating: "easy", now: reviewTime2 });

		const storedEp = await storage.getEpisodeById(userId, ep.id);
		expect(storedEp!.stability).toBeGreaterThan(0);
		expect(updated!.lastReviewedAt).toEqual(reviewTime2);
	});

	test("review with 'again' decreases stability", async () => {
		const ep = makeEpisode();
		await storage.saveEpisode(userId, ep);

		const reviewTime1 = new Date("2026-01-01T00:00:00Z");
		await episodic.review(userId, ep.id, { rating: "good", now: reviewTime1 });
		const afterGood = await storage.getEpisodeById(userId, ep.id);
		const stabilityAfterGood = afterGood!.stability;

		const reviewTime2 = new Date("2026-01-02T00:00:00Z");
		await episodic.review(userId, ep.id, { rating: "again", now: reviewTime2 });
		const afterAgain = await storage.getEpisodeById(userId, ep.id);

		expect(afterAgain!.stability).toBeLessThan(stabilityAfterGood);
	});

	test("review with 'hard' rating adjusts stability", async () => {
		const ep = makeEpisode();
		await storage.saveEpisode(userId, ep);

		const reviewTime1 = new Date("2026-01-01T00:00:00Z");
		await episodic.review(userId, ep.id, { rating: "good", now: reviewTime1 });
		const afterGood = await storage.getEpisodeById(userId, ep.id);
		const stabilityAfterGood = afterGood!.stability;

		const reviewTime2 = new Date("2026-01-02T00:00:00Z");
		await episodic.review(userId, ep.id, { rating: "hard", now: reviewTime2 });
		const afterHard = await storage.getEpisodeById(userId, ep.id);

		expect(afterHard!.stability).toBeLessThan(stabilityAfterGood);
	});

	test("review returns null for unknown episode", async () => {
		const result = await episodic.review(userId, "nonexistent", { rating: "good" });
		expect(result).toBeNull();
	});
});

describe("EpisodicMemory — consolidation", () => {
	let storage: LtmStorage;
	let episodic: EpisodicMemory;

	beforeEach(() => {
		storage = new LtmStorage(":memory:");
		episodic = new EpisodicMemory(storage);
	});

	afterEach(() => {
		storage.close();
	});

	test("markConsolidated sets consolidatedAt", async () => {
		const ep = makeEpisode();
		await storage.saveEpisode(userId, ep);

		await episodic.markConsolidated(userId, ep.id);

		const updated = await storage.getEpisodeById(userId, ep.id);
		expect(updated!.consolidatedAt).not.toBeNull();
		expect(updated!.consolidatedAt).toBeInstanceOf(Date);
	});
});

describe("EpisodicMemory — retrievability", () => {
	let storage: LtmStorage;
	let episodic: EpisodicMemory;

	beforeEach(() => {
		storage = new LtmStorage(":memory:");
		episodic = new EpisodicMemory(storage);
	});

	afterEach(() => {
		storage.close();
	});

	test("retrievability is 1.0 for never-reviewed episode", () => {
		const ep = makeEpisode();
		const r = episodic.getRetrievability(ep);
		expect(r).toBe(1.0);
	});

	test("retrievability decays over time", () => {
		const ep = makeEpisode();
		const reviewed: Episode = {
			...ep,
			lastReviewedAt: new Date("2026-01-01T00:00:00Z"),
		};

		const oneDayLater = new Date("2026-01-02T00:00:00Z");
		const oneWeekLater = new Date("2026-01-08T00:00:00Z");

		const rDay = episodic.getRetrievability(reviewed, oneDayLater);
		const rWeek = episodic.getRetrievability(reviewed, oneWeekLater);

		expect(rDay).toBeGreaterThan(rWeek);
		expect(rDay).toBeLessThan(1.0);
		expect(rWeek).toBeLessThan(1.0);
	});

	test("higher stability leads to slower decay", () => {
		const ep = makeEpisode();
		const reviewed = new Date("2026-01-01T00:00:00Z");
		const now = new Date("2026-01-08T00:00:00Z");

		const lowStability: Episode = { ...ep, stability: 1.0, lastReviewedAt: reviewed };
		const highStability: Episode = { ...ep, stability: 5.0, lastReviewedAt: reviewed };

		const rLow = episodic.getRetrievability(lowStability, now);
		const rHigh = episodic.getRetrievability(highStability, now);

		expect(rHigh).toBeGreaterThan(rLow);
	});
});
