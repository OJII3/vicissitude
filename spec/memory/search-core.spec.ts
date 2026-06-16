import { describe, expect, test } from "bun:test";

import {
	CANDIDATE_LIMIT,
	DEFAULT_TEXT_WEIGHT,
	DEFAULT_VECTOR_WEIGHT,
	hybridSearchFactsRRF,
	reciprocalRankFusion,
	RRF_K,
} from "@vicissitude/memory/search-core";

import { makeFact } from "./test-helpers.ts";

describe("search-core constants (single source of truth)", () => {
	test("CANDIDATE_LIMIT は検索候補数のチューニング値である", () => {
		expect(CANDIDATE_LIMIT).toBe(50);
	});

	test("RRF_K は TREC 標準値である", () => {
		expect(RRF_K).toBe(60);
	});

	test("RRF 重みのデフォルトは text/vector ともに 1.0 である", () => {
		expect(DEFAULT_TEXT_WEIGHT).toBe(1.0);
		expect(DEFAULT_VECTOR_WEIGHT).toBe(1.0);
	});
});

describe("search-core が retrieval の re-export と同一実体である", () => {
	test("reciprocalRankFusion は retrieval から再エクスポートされた同一関数である", async () => {
		const fromRetrieval = await import("@vicissitude/memory/retrieval");
		expect(fromRetrieval.reciprocalRankFusion).toBe(reciprocalRankFusion);
	});
});

describe("reciprocalRankFusion", () => {
	test("単一リストはランク順にスコアを付与する", () => {
		const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
		const scores = reciprocalRankFusion([{ items, weight: 1.0 }], (x) => x.id);

		expect(scores.get("a")).toBeCloseTo(1 / 61, 10);
		expect(scores.get("b")).toBeCloseTo(1 / 62, 10);
		expect(scores.get("c")).toBeCloseTo(1 / 63, 10);
	});

	test("両リストに含まれる項目はスコアが合算される", () => {
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
	});

	test("空リストは空マップを返す", () => {
		const scores = reciprocalRankFusion(
			[{ items: [] as { id: string }[], weight: 1.0 }],
			(x) => x.id,
		);
		expect(scores.size).toBe(0);
	});
});

describe("hybridSearchFactsRRF (fact-only ランキングプリミティブ)", () => {
	test("text と vector の両方にマッチする fact が最上位になる", () => {
		const both = makeFact({ fact: "both", keywords: ["x"] });
		const textOnly = makeFact({ fact: "text-only", keywords: ["y"] });
		const vectorOnly = makeFact({ fact: "vector-only", keywords: ["z"] });

		const ranked = hybridSearchFactsRRF([both, textOnly], [both, vectorOnly]);

		expect(ranked[0]?.fact.id).toBe(both.id);
		expect(ranked).toHaveLength(3);
	});

	test("スコア降順でソートされる", () => {
		const a = makeFact({ fact: "a", keywords: ["a"] });
		const b = makeFact({ fact: "b", keywords: ["b"] });
		const c = makeFact({ fact: "c", keywords: ["c"] });

		const scores = hybridSearchFactsRRF([a, b, c], []).map((r) => r.score);

		for (let i = 1; i < scores.length; i++) {
			expect(scores[i - 1] ?? 0).toBeGreaterThanOrEqual(scores[i] ?? 0);
		}
	});

	test("両リストが空なら空配列を返す", () => {
		expect(hybridSearchFactsRRF([], [])).toEqual([]);
	});

	test("重複 id は1件に統合され合算スコアを持つ", () => {
		const fact = makeFact({ fact: "dup", keywords: ["d"] });

		const ranked = hybridSearchFactsRRF([fact], [fact]);

		expect(ranked).toHaveLength(1);
		expect(ranked[0]?.score).toBeCloseTo(1 / 61 + 1 / 61, 10);
	});

	test("weight=0 のリストはスコアに寄与しない", () => {
		const t = makeFact({ fact: "t", keywords: ["t"] });
		const v = makeFact({ fact: "v", keywords: ["v"] });

		const ranked = hybridSearchFactsRRF([t], [v], { textWeight: 1.0, vectorWeight: 0 });

		const vScore = ranked.find((r) => r.fact.id === v.id)?.score;
		expect(vScore).toBe(0);
	});
});
