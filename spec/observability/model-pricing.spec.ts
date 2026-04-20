import { describe, expect, it } from "bun:test";

import { getModelPricing, calculateCost } from "@vicissitude/observability/model-pricing";

describe("getModelPricing", () => {
	it("既知モデル（gpt-4o）の単価が取得できる", () => {
		const pricing = getModelPricing("gpt-4o");
		expect(pricing).toBeDefined();
		expect(pricing!.inputPerMillionTokens).toBeGreaterThan(0);
		expect(pricing!.outputPerMillionTokens).toBeGreaterThan(0);
		expect(pricing!.cacheReadPerMillionTokens).toBeGreaterThanOrEqual(0);
	});

	it("未知モデルでは undefined が返る", () => {
		const pricing = getModelPricing("unknown-model-xyz");
		expect(pricing).toBeUndefined();
	});
});

describe("calculateCost", () => {
	it("トークン数と単価から正しいコスト（USD）を計算する", () => {
		const pricing = {
			inputPerMillionTokens: 2.5,
			outputPerMillionTokens: 10.0,
			cacheReadPerMillionTokens: 1.25,
		};
		const tokens = { input: 1_000_000, output: 500_000, cacheRead: 200_000 };

		const cost = calculateCost(tokens, pricing);

		// input:  1_000_000 * 2.5  / 1_000_000 = 2.5
		// output:   500_000 * 10.0 / 1_000_000 = 5.0
		// cache:    200_000 * 1.25 / 1_000_000 = 0.25
		// total = 7.75
		expect(cost).toBeCloseTo(7.75, 10);
	});

	it("トークン数が全て 0 の場合はコストが 0 である", () => {
		const pricing = {
			inputPerMillionTokens: 2.5,
			outputPerMillionTokens: 10.0,
			cacheReadPerMillionTokens: 1.25,
		};
		const tokens = { input: 0, output: 0, cacheRead: 0 };

		const cost = calculateCost(tokens, pricing);

		expect(cost).toBe(0);
	});

	it("小数点以下の精度が保たれる", () => {
		const pricing = {
			inputPerMillionTokens: 3.0,
			outputPerMillionTokens: 15.0,
			cacheReadPerMillionTokens: 0.0,
		};
		const tokens = { input: 150, output: 80, cacheRead: 0 };

		const cost = calculateCost(tokens, pricing);

		// input:  150 * 3.0  / 1_000_000 = 0.00045
		// output:  80 * 15.0 / 1_000_000 = 0.0012
		// total = 0.00165
		expect(cost).toBeCloseTo(0.00165, 10);
	});
});
