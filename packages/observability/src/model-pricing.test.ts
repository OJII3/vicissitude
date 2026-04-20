import { describe, expect, it } from "bun:test";

import type { TokenUsage } from "@vicissitude/shared/types";

import { calculateCost, getModelPricing } from "./model-pricing";

describe("getModelPricing", () => {
	it("gpt-4o の具体的な単価値を返す", () => {
		const pricing = getModelPricing("gpt-4o");
		expect(pricing).toEqual({
			inputPerMillionTokens: 2.5,
			outputPerMillionTokens: 10.0,
			cacheReadPerMillionTokens: 1.25,
		});
	});

	it("gpt-4o-mini の具体的な単価値を返す", () => {
		const pricing = getModelPricing("gpt-4o-mini");
		expect(pricing).toEqual({
			inputPerMillionTokens: 0.15,
			outputPerMillionTokens: 0.6,
			cacheReadPerMillionTokens: 0.075,
		});
	});

	it("空文字列の場合は undefined を返す", () => {
		expect(getModelPricing("")).toBeUndefined();
	});
});

describe("calculateCost", () => {
	const pricing = {
		inputPerMillionTokens: 2.0,
		outputPerMillionTokens: 8.0,
		cacheReadPerMillionTokens: 1.0,
	};

	it("input トークンのみの場合、input 単価だけが効く", () => {
		const tokens: TokenUsage = { input: 1_000_000, output: 0, cacheRead: 0 };
		expect(calculateCost(tokens, pricing)).toBe(2.0);
	});

	it("output トークンのみの場合、output 単価だけが効く", () => {
		const tokens: TokenUsage = { input: 0, output: 1_000_000, cacheRead: 0 };
		expect(calculateCost(tokens, pricing)).toBe(8.0);
	});

	it("cacheRead トークンのみの場合、cacheRead 単価だけが効く", () => {
		const tokens: TokenUsage = { input: 0, output: 0, cacheRead: 1_000_000 };
		expect(calculateCost(tokens, pricing)).toBe(1.0);
	});

	it("全トークンが 0 の場合はコストが 0 である", () => {
		const tokens: TokenUsage = { input: 0, output: 0, cacheRead: 0 };
		expect(calculateCost(tokens, pricing)).toBe(0);
	});
});
