import { describe, expect, it } from "bun:test";

import { createEmotion } from "@vicissitude/shared/emotion";

import { createEmotionToExpressionMapper } from "./emotion-to-expression-mapper";

const mapper = createEmotionToExpressionMapper();

// ─── mapFallback — fallback 分岐の expression と weight ──────────
//
// V=0 のとき mapPrimaryExpression は null を返し、mapFallback に到達する。
// 各分岐で expression と weight の具体値を検証する。

describe("mapFallback — fallback 分岐の expression と weight", () => {
	it("V=0, A>0, D>0 → angry, weight = (|A|+|D|)/2", () => {
		const result = mapper.mapToExpression(createEmotion(0, 0.5, 0.4));
		expect(result.expression).toBe("angry");
		// computeWeight(0.5, 0.4) = (0.5 + 0.4) / 2 = 0.45
		expect(result.weight).toBeCloseTo(0.45, 5);
	});

	it("V=0, A>0, D<0 → fear, weight = (|A|+|D|)/2", () => {
		const result = mapper.mapToExpression(createEmotion(0, 0.6, -0.8));
		expect(result.expression).toBe("fear");
		// computeWeight(0.6, 0.8) = (0.6 + 0.8) / 2 = 0.7
		expect(result.weight).toBeCloseTo(0.7, 5);
	});

	it("V=0, A>0, D=0 → happy, weight = |A| (computeWeight 引数1つ)", () => {
		const result = mapper.mapToExpression(createEmotion(0, 0.5, 0));
		expect(result.expression).toBe("happy");
		// computeWeight(0.5) = 0.5 / 1 = 0.5
		expect(result.weight).toBeCloseTo(0.5, 5);
	});

	it("V=0, A<0, D=0 → sad, weight = (|A|+|D|)/2", () => {
		const result = mapper.mapToExpression(createEmotion(0, -0.6, 0));
		expect(result.expression).toBe("sad");
		// computeWeight(0.6, 0) = (0.6 + 0) / 2 = 0.3
		expect(result.weight).toBeCloseTo(0.3, 5);
	});

	it("V=0, A<0, D=0.4 → sad, weight = (|A|+|D|)/2", () => {
		const result = mapper.mapToExpression(createEmotion(0, -0.4, 0.4));
		expect(result.expression).toBe("sad");
		// computeWeight(0.4, 0.4) = (0.4 + 0.4) / 2 = 0.4
		expect(result.weight).toBeCloseTo(0.4, 5);
	});

	it("V=0, A=0, D=0.5 → neutral (最終 fallback), weight = (|A|+|D|)/2", () => {
		const result = mapper.mapToExpression(createEmotion(0, 0, 0.5));
		expect(result.expression).toBe("neutral");
		// computeWeight(0, 0.5) = (0 + 0.5) / 2 = 0.25
		expect(result.weight).toBeCloseTo(0.25, 5);
	});

	it("V=0, A=0, D=-0.8 → neutral (最終 fallback), weight = (|A|+|D|)/2", () => {
		const result = mapper.mapToExpression(createEmotion(0, 0, -0.8));
		expect(result.expression).toBe("neutral");
		// computeWeight(0, 0.8) = (0 + 0.8) / 2 = 0.4
		expect(result.weight).toBeCloseTo(0.4, 5);
	});
});

// ─── computeWeight — 主要ルールの具体値 ──────────────────────────
//
// mapPrimaryExpression が各 expression を返すとき、
// computeWeight に渡される引数と計算結果を正確に検証する。

describe("computeWeight — 主要ルールの具体値", () => {
	it("happy: weight = (V + A + |D|) / 3", () => {
		// V=0.6, A=0.4, D=0.2 → computeWeight(0.6, 0.4, 0.2) = 1.2/3 = 0.4
		const result = mapper.mapToExpression(createEmotion(0.6, 0.4, 0.2));
		expect(result.expression).toBe("happy");
		expect(result.weight).toBeCloseTo(0.4, 5);
	});

	it("happy: D が負でも |D| が使われる", () => {
		// V=0.6, A=0.4, D=-0.3 → computeWeight(0.6, 0.4, 0.3) = 1.3/3 ≈ 0.4333
		const result = mapper.mapToExpression(createEmotion(0.6, 0.4, -0.3));
		expect(result.expression).toBe("happy");
		expect(result.weight).toBeCloseTo(1.3 / 3, 5);
	});

	it("relaxed: weight = (V + |A| + |D|) / 3", () => {
		// V=0.8, A=-0.6, D=0.4 → computeWeight(0.8, 0.6, 0.4) = 1.8/3 = 0.6
		const result = mapper.mapToExpression(createEmotion(0.8, -0.6, 0.4));
		expect(result.expression).toBe("relaxed");
		expect(result.weight).toBeCloseTo(0.6, 5);
	});

	it("angry: weight = (|V| + A + D) / 3", () => {
		// V=-0.6, A=0.5, D=0.4 → computeWeight(0.6, 0.5, 0.4) = 1.5/3 = 0.5
		const result = mapper.mapToExpression(createEmotion(-0.6, 0.5, 0.4));
		expect(result.expression).toBe("angry");
		expect(result.weight).toBeCloseTo(0.5, 5);
	});

	it("fear: weight = (|V| + A + |D|) / 3", () => {
		// V=-0.5, A=0.4, D=-0.3 → computeWeight(0.5, 0.4, 0.3) = 1.2/3 = 0.4
		const result = mapper.mapToExpression(createEmotion(-0.5, 0.4, -0.3));
		expect(result.expression).toBe("fear");
		expect(result.weight).toBeCloseTo(0.4, 5);
	});

	it("sad: weight = (|V| + |A| + |D|) / 3", () => {
		// V=-0.9, A=-0.6, D=-0.3 → computeWeight(0.9, 0.6, 0.3) = 1.8/3 = 0.6
		const result = mapper.mapToExpression(createEmotion(-0.9, -0.6, -0.3));
		expect(result.expression).toBe("sad");
		expect(result.weight).toBeCloseTo(0.6, 5);
	});

	it("surprised: weight = (A + |D|) / 2 (引数2つ)", () => {
		// A=0.8, D=-0.6 → computeWeight(0.8, 0.6) = 1.4/2 = 0.7
		const result = mapper.mapToExpression(createEmotion(0, 0.8, -0.6));
		expect(result.expression).toBe("surprised");
		expect(result.weight).toBeCloseTo(0.7, 5);
	});

	it("surprised: V の値は weight 計算に影響しない", () => {
		const r1 = mapper.mapToExpression(createEmotion(0.3, 0.8, -0.6));
		const r2 = mapper.mapToExpression(createEmotion(-0.9, 0.8, -0.6));
		expect(r1.expression).toBe("surprised");
		expect(r2.expression).toBe("surprised");
		// どちらも computeWeight(0.8, 0.6) = 0.7
		expect(r1.weight).toBeCloseTo(r2.weight, 5);
	});
});

// ─── mapNeutral — ユークリッド距離による weight 計算 ──────────────

describe("mapNeutral — ユークリッド距離による weight 計算", () => {
	// ≈ 0.34641
	const maxDistance = Math.sqrt(0.2 * 0.2 * 3);

	it("原点 (0,0,0) → distance=0, weight=1.0", () => {
		const result = mapper.mapToExpression(createEmotion(0, 0, 0));
		expect(result.expression).toBe("neutral");
		expect(result.weight).toBeCloseTo(1.0, 5);
	});

	it("(0.1, 0.1, 0.1) → distance=sqrt(0.03), weight=1-sqrt(0.03)/maxDistance", () => {
		const result = mapper.mapToExpression(createEmotion(0.1, 0.1, 0.1));
		expect(result.expression).toBe("neutral");
		const distance = Math.sqrt(0.01 + 0.01 + 0.01);
		const expected = 1 - distance / maxDistance;
		expect(result.weight).toBeCloseTo(expected, 5);
	});

	it("(0.19, 0.19, 0.19) → 境界ギリギリ、weight は小さいが正", () => {
		const result = mapper.mapToExpression(createEmotion(0.19, 0.19, 0.19));
		expect(result.expression).toBe("neutral");
		const distance = Math.sqrt(0.19 * 0.19 * 3);
		const expected = 1 - distance / maxDistance;
		expect(result.weight).toBeCloseTo(expected, 5);
		expect(result.weight).toBeGreaterThan(0);
	});

	it("単一軸のみ: (0.15, 0, 0) → distance=0.15", () => {
		const result = mapper.mapToExpression(createEmotion(0.15, 0, 0));
		expect(result.expression).toBe("neutral");
		const expected = 1 - 0.15 / maxDistance;
		expect(result.weight).toBeCloseTo(expected, 5);
	});

	it("負の軸: (-0.1, -0.1, -0.1) → distance は正の (0.1,0.1,0.1) と同じ", () => {
		const pos = mapper.mapToExpression(createEmotion(0.1, 0.1, 0.1));
		const neg = mapper.mapToExpression(createEmotion(-0.1, -0.1, -0.1));
		expect(neg.expression).toBe("neutral");
		expect(neg.weight).toBeCloseTo(pos.weight, 5);
	});
});

// ─── clampWeight — 境界 ─────────────────────────────────────────
//
// computeWeight の結果が [0, 1] 範囲にクランプされることを検証。
// また mapNeutral で理論値が負になるケースも検証。

describe("clampWeight — 境界", () => {
	it("全軸最大 (1,1,1) → happy, weight=1.0 (clamp 上限)", () => {
		// computeWeight(1, 1, 1) = 3/3 = 1.0 → clamp 不要だが上限ぴったり
		const result = mapper.mapToExpression(createEmotion(1, 1, 1));
		expect(result.expression).toBe("happy");
		expect(result.weight).toBeCloseTo(1.0, 5);
	});

	it("全軸最小 (-1,-1,-1) → sad, weight=1.0 (clamp 上限)", () => {
		// computeWeight(1, 1, 1) = 3/3 = 1.0
		const result = mapper.mapToExpression(createEmotion(-1, -1, -1));
		expect(result.expression).toBe("sad");
		expect(result.weight).toBeCloseTo(1.0, 5);
	});

	it("非常に小さい主要値 → weight は 0 にクランプされない限り正", () => {
		// V=0.01, A=0.01, D=0 → happy, computeWeight(0.01, 0.01, 0) ≈ 0.00667
		const result = mapper.mapToExpression(createEmotion(0.21, 0.21, 0));
		expect(result.expression).toBe("happy");
		// computeWeight(0.21, 0.21, 0) = 0.42/3 = 0.14
		expect(result.weight).toBeCloseTo(0.14, 2);
	});

	it("fallback の最終分岐で A=0, D=0 → weight=0 (clamp 下限)", () => {
		// V=0, A=0, D=0 は neutral 条件 (|V|<0.2 && |A|<0.2 && |D|<0.2) を満たすため
		// mapNeutral に行く。fallback には到達しない。
		// V=0.3 にすると neutral 条件を外れ、V>0 && A=0 で mapPrimary は null。
		// fallback: a=0 → 最終分岐 neutral, computeWeight(0, 0) = 0
		const result = mapper.mapToExpression(createEmotion(0.3, 0, 0));
		expect(result.expression).toBe("neutral");
		expect(result.weight).toBeCloseTo(0, 5);
	});

	it("surprised で A=1, D=-1 → weight=1.0", () => {
		// computeWeight(1, 1) = 2/2 = 1.0
		const result = mapper.mapToExpression(createEmotion(0, 1, -1));
		expect(result.expression).toBe("surprised");
		expect(result.weight).toBeCloseTo(1.0, 5);
	});

	it("relaxed で全軸最大相当: V=1, A=-1, D=1 → weight=1.0", () => {
		// computeWeight(1, 1, 1) = 3/3 = 1.0
		const result = mapper.mapToExpression(createEmotion(1, -1, 1));
		expect(result.expression).toBe("relaxed");
		expect(result.weight).toBeCloseTo(1.0, 5);
	});
});
