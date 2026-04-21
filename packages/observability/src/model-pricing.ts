import type { TokenUsage } from "@vicissitude/shared/types";

// ─── Model Pricing ─────────────────────────────────────────────

export interface ModelPricing {
	/** USD per 1M input tokens */
	inputPerMillionTokens: number;
	/** USD per 1M output tokens */
	outputPerMillionTokens: number;
	/** USD per 1M cache-read tokens */
	cacheReadPerMillionTokens: number;
}

/**
 * 既知モデルの単価テーブル（2024 年時点の概算）。
 * 未知モデルは undefined を返す。
 */
const PRICING_TABLE: ReadonlyMap<string, ModelPricing> = new Map<string, ModelPricing>([
	[
		"gpt-4o",
		{ inputPerMillionTokens: 2.5, outputPerMillionTokens: 10.0, cacheReadPerMillionTokens: 1.25 },
	],
	[
		"gpt-4o-mini",
		{ inputPerMillionTokens: 0.15, outputPerMillionTokens: 0.6, cacheReadPerMillionTokens: 0.075 },
	],
]);

export function getModelPricing(modelId: string): ModelPricing | undefined {
	return PRICING_TABLE.get(modelId);
}

export function calculateCost(tokens: TokenUsage, pricing: ModelPricing): number {
	return (
		(tokens.input * pricing.inputPerMillionTokens +
			tokens.output * pricing.outputPerMillionTokens +
			tokens.cacheRead * pricing.cacheReadPerMillionTokens) /
		1_000_000
	);
}
