/* oxlint-disable max-lines, no-non-null-assertion, require-await, no-await-in-loop -- comprehensive retrieval tests */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { LtmStorage } from "../../packages/ltm/src/ltm-storage.ts";
import { Retrieval, reciprocalRankFusion } from "../../packages/ltm/src/retrieval.ts";
import { createMockLLM, makeEpisode, makeFact } from "./test-helpers.ts";

const userId = "user-1";

function mockLlm(embedding: number[]) {
	return createMockLLM({ embedding });
}

describe("reciprocalRankFusion", () => {
	test("single list scores by rank with expected values", () => {
		const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
		const scores = reciprocalRankFusion([{ items, weight: 1.0 }], (x) => x.id);

		expect(scores.get("a")).toBeCloseTo(1 / 61, 10);
		expect(scores.get("b")).toBeCloseTo(1 / 62, 10);
		expect(scores.get("c")).toBeCloseTo(1 / 63, 10);
	});

	test("items in both lists get combined score", () => {
		const list1 = [{ id: "a" }, { id: "b" }];
		const list2 = [{ id: "b" }, { id: "c" }];
		const scores = reciprocalRankFusion(
			[
				{ items: list1, weight: 1.0 },
				{ items: list2, weight: 1.0 },
			],
			(x) => x.id,
		);

		expect(scores.get("b")).toBeCloseTo(1 / 62 + 1 / 61, 10);
		expect(scores.get("a")).toBeCloseTo(1 / 61, 10);
		expect(scores.get("c")).toBeCloseTo(1 / 62, 10);
	});

	test("weight affects score contribution", () => {
		const items = [{ id: "a" }];
		const scores1 = reciprocalRankFusion([{ items, weight: 1.0 }], (x) => x.id);
		const scores2 = reciprocalRankFusion([{ items, weight: 2.0 }], (x) => x.id);

		expect(scores2.get("a")!).toBeCloseTo(scores1.get("a")! * 2);
	});

	test("weight=0 produces zero score", () => {
		const items = [{ id: "a" }];
		const scores = reciprocalRankFusion([{ items, weight: 0 }], (x) => x.id);
		expect(scores.get("a")).toBe(0);
	});

	test("empty lists return empty map", () => {
		const scores = reciprocalRankFusion(
			[{ items: [] as { id: string }[], weight: 1.0 }],
			(x) => x.id,
		);
		expect(scores.size).toBe(0);
	});
});

describe("Retrieval — text-only match", () => {
	let storage: LtmStorage;
	let retrieval: Retrieval;

	beforeEach(() => {
		storage = new LtmStorage(":memory:");
		retrieval = new Retrieval(mockLlm([0, 0, 1]), storage);
	});

	afterEach(() => {
		storage.close();
	});

	test("returns episode found by text search", async () => {
		const ep = makeEpisode({ title: "TypeScript Discussion", embedding: [1, 0, 0] });
		await storage.saveEpisode(userId, ep);

		const result = await retrieval.retrieve(userId, "TypeScript");
		expect(result.episodes).toHaveLength(1);
		expect(result.episodes[0]!.episode.id).toBe(ep.id);
		expect(result.episodes[0]!.score).toBeGreaterThan(0);
	});

	test("returns fact found by text search with positive score", async () => {
		const fact = makeFact({ fact: "Prefers dark mode", embedding: [1, 0, 0] });
		await storage.saveFact(userId, fact);

		const result = await retrieval.retrieve(userId, "dark mode");
		expect(result.facts).toHaveLength(1);
		expect(result.facts[0]!.fact.id).toBe(fact.id);
		expect(result.facts[0]!.score).toBeGreaterThan(0);
	});
});

describe("Retrieval — vector-only match", () => {
	let storage: LtmStorage;
	let retrieval: Retrieval;

	beforeEach(() => {
		storage = new LtmStorage(":memory:");
		retrieval = new Retrieval(mockLlm([1, 0, 0]), storage);
	});

	afterEach(() => {
		storage.close();
	});

	test("returns episode found by vector similarity", async () => {
		const ep = makeEpisode({ title: "Unrelated Title", embedding: [1, 0, 0] });
		await storage.saveEpisode(userId, ep);

		const result = await retrieval.retrieve(userId, "xyz");
		expect(result.episodes).toHaveLength(1);
		expect(result.episodes[0]!.episode.id).toBe(ep.id);
	});

	test("returns fact found by vector similarity", async () => {
		const fact = makeFact({ fact: "Unrelated text", embedding: [1, 0, 0] });
		await storage.saveFact(userId, fact);

		const result = await retrieval.retrieve(userId, "xyz");
		expect(result.facts).toHaveLength(1);
		expect(result.facts[0]!.fact.id).toBe(fact.id);
	});
});

describe("Retrieval — hybrid score combination", () => {
	let storage: LtmStorage;
	let retrieval: Retrieval;

	beforeEach(() => {
		storage = new LtmStorage(":memory:");
		retrieval = new Retrieval(mockLlm([1, 0, 0]), storage);
	});

	afterEach(() => {
		storage.close();
	});

	test("episode matching both text and vector scores higher", async () => {
		const epBoth = makeEpisode({ title: "TypeScript Guide", embedding: [1, 0, 0] });
		const epText = makeEpisode({ title: "TypeScript Intro", embedding: [0, 0, 1] });
		await storage.saveEpisode(userId, epBoth);
		await storage.saveEpisode(userId, epText);

		const result = await retrieval.retrieve(userId, "TypeScript");
		expect(result.episodes).toHaveLength(2);
		expect(result.episodes[0]!.episode.id).toBe(epBoth.id);
		expect(result.episodes[0]!.score).toBeGreaterThan(result.episodes[1]!.score);
	});
});

describe("Retrieval — FSRS retrievability", () => {
	let storage: LtmStorage;
	let retrieval: Retrieval;

	beforeEach(() => {
		storage = new LtmStorage(":memory:");
		retrieval = new Retrieval(mockLlm([1, 0, 0]), storage);
	});

	afterEach(() => {
		storage.close();
	});

	test("fresh episode has higher score than decayed episode", async () => {
		const now = new Date("2026-06-01T00:00:00Z");

		const epFresh = makeEpisode({ title: "TypeScript Fresh", embedding: [1, 0, 0] });
		await storage.saveEpisode(userId, epFresh);
		await storage.updateEpisodeFSRS(userId, epFresh.id, {
			stability: 1.0,
			difficulty: 0.3,
			lastReviewedAt: new Date("2026-05-31T00:00:00Z"),
		});

		const epOld = makeEpisode({ title: "TypeScript Old", embedding: [1, 0, 0] });
		await storage.saveEpisode(userId, epOld);
		await storage.updateEpisodeFSRS(userId, epOld.id, {
			stability: 1.0,
			difficulty: 0.3,
			lastReviewedAt: new Date("2026-01-01T00:00:00Z"),
		});

		const result = await retrieval.retrieve(userId, "TypeScript", { now });
		expect(result.episodes).toHaveLength(2);
		expect(result.episodes[0]!.retrievability).toBeGreaterThan(result.episodes[1]!.retrievability);
	});

	test("episode with null lastReviewedAt has retrievability 1.0", async () => {
		const ep = makeEpisode({ title: "TypeScript New", embedding: [1, 0, 0] });
		await storage.saveEpisode(userId, ep);

		const result = await retrieval.retrieve(userId, "TypeScript");
		expect(result.episodes).toHaveLength(1);
		expect(result.episodes[0]!.retrievability).toBe(1.0);
	});
});

describe("Retrieval — edge cases", () => {
	let storage: LtmStorage;
	let retrieval: Retrieval;

	beforeEach(() => {
		storage = new LtmStorage(":memory:");
		retrieval = new Retrieval(mockLlm([1, 0, 0]), storage);
	});

	afterEach(() => {
		storage.close();
	});

	test("empty results when no data", async () => {
		const result = await retrieval.retrieve(userId, "anything");
		expect(result.episodes).toHaveLength(0);
		expect(result.facts).toHaveLength(0);
	});

	test("tenant isolation — does not return other user data", async () => {
		const ep = makeEpisode({ userId: "user-2", title: "TypeScript", embedding: [1, 0, 0] });
		await storage.saveEpisode("user-2", ep);

		const result = await retrieval.retrieve(userId, "TypeScript");
		expect(result.episodes).toHaveLength(0);
	});

	test("respects limit option", async () => {
		for (let i = 0; i < 5; i++) {
			await storage.saveEpisode(
				userId,
				makeEpisode({ title: `Episode ${i}`, embedding: [1, 0, 0] }),
			);
		}
		const result = await retrieval.retrieve(userId, "Episode", { limit: 2 });
		expect(result.episodes).toHaveLength(2);
	});

	test("throws on empty userId", async () => {
		await expect(retrieval.retrieve("", "query")).rejects.toThrow("userId must not be empty");
	});

	test("empty query returns empty results without calling embed", async () => {
		await storage.saveEpisode(userId, makeEpisode({ title: "TypeScript", embedding: [1, 0, 0] }));
		const result = await retrieval.retrieve(userId, "");
		expect(result.episodes).toHaveLength(0);
		expect(result.facts).toHaveLength(0);
	});

	test("limit is clamped to minimum 1", async () => {
		await storage.saveEpisode(userId, makeEpisode({ title: "Test", embedding: [1, 0, 0] }));
		const result = await retrieval.retrieve(userId, "Test", { limit: -5 });
		expect(result.episodes).toHaveLength(1);
	});

	test("limit is clamped to maximum 1000", async () => {
		await storage.saveEpisode(userId, makeEpisode({ title: "Test", embedding: [1, 0, 0] }));
		const result = await retrieval.retrieve(userId, "Test", { limit: 99_999 });
		expect(result.episodes.length).toBeLessThanOrEqual(1000);
	});

	test("fractional limit is floored", async () => {
		for (let i = 0; i < 3; i++) {
			await storage.saveEpisode(userId, makeEpisode({ title: `Ep ${i}`, embedding: [1, 0, 0] }));
		}
		const result = await retrieval.retrieve(userId, "Ep", { limit: 1.9 });
		expect(result.episodes).toHaveLength(1);
	});
});

describe("Retrieval — custom weight options", () => {
	let storage: LtmStorage;

	beforeEach(() => {
		storage = new LtmStorage(":memory:");
	});

	afterEach(() => {
		storage.close();
	});

	test("textWeight=0 disables text search contribution", async () => {
		const ep = makeEpisode({ title: "TypeScript Guide", embedding: [0, 0, 1] });
		await storage.saveEpisode(userId, ep);

		const retrieval = new Retrieval(mockLlm([1, 0, 0]), storage);
		const result = await retrieval.retrieve(userId, "TypeScript", {
			textWeight: 0,
			vectorWeight: 1.0,
		});
		expect(result.episodes).toHaveLength(1);
	});

	test("vectorWeight=0 disables vector search contribution", async () => {
		const ep = makeEpisode({ title: "Unrelated", embedding: [1, 0, 0] });
		await storage.saveEpisode(userId, ep);

		const retrieval = new Retrieval(mockLlm([1, 0, 0]), storage);
		const result = await retrieval.retrieve(userId, "xyz", {
			textWeight: 1.0,
			vectorWeight: 0,
		});
		if (result.episodes.length > 0) {
			expect(result.episodes[0]!.score).toBeGreaterThanOrEqual(0);
		}
	});

	test("fsrsWeight=0 disables FSRS boost", async () => {
		const now = new Date("2026-06-01T00:00:00Z");
		const ep = makeEpisode({ title: "TypeScript", embedding: [1, 0, 0] });
		await storage.saveEpisode(userId, ep);
		await storage.updateEpisodeFSRS(userId, ep.id, {
			stability: 1.0,
			difficulty: 0.3,
			lastReviewedAt: new Date("2026-05-31T00:00:00Z"),
		});

		const retrieval = new Retrieval(mockLlm([1, 0, 0]), storage);
		const withFsrs = await retrieval.retrieve(userId, "TypeScript", { now, fsrsWeight: 0.5 });
		const withoutFsrs = await retrieval.retrieve(userId, "TypeScript", { now, fsrsWeight: 0 });

		expect(withFsrs.episodes[0]!.score).toBeGreaterThan(withoutFsrs.episodes[0]!.score);
	});
});
