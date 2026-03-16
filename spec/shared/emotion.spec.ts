import { describe, expect, it } from "bun:test";

import {
	type Emotion,
	EmotionSchema,
	type EmotionToExpressionMapper,
	NEUTRAL_EMOTION,
	type VrmExpression,
	VrmExpressionSchema,
	type VrmExpressionWeight,
	VrmExpressionWeightSchema,
	createEmotion,
} from "@vicissitude/shared/emotion";

// ─── Emotion type & factory ─────────────────────────────────────

describe("createEmotion", () => {
	it("creates an Emotion with given values within range", () => {
		const e = createEmotion(0.5, -0.3, 0.7);
		expect(e.valence).toBeCloseTo(0.5);
		expect(e.arousal).toBeCloseTo(-0.3);
		expect(e.dominance).toBeCloseTo(0.7);
	});

	it("clamps values exceeding upper bound to 1", () => {
		const e = createEmotion(1.5, 2.0, 999);
		expect(e.valence).toBe(1);
		expect(e.arousal).toBe(1);
		expect(e.dominance).toBe(1);
	});

	it("clamps values below lower bound to -1", () => {
		const e = createEmotion(-1.5, -2.0, -999);
		expect(e.valence).toBe(-1);
		expect(e.arousal).toBe(-1);
		expect(e.dominance).toBe(-1);
	});

	it("accepts boundary values exactly", () => {
		const e1 = createEmotion(-1, -1, -1);
		expect(e1.valence).toBe(-1);
		expect(e1.arousal).toBe(-1);
		expect(e1.dominance).toBe(-1);

		const e2 = createEmotion(1, 1, 1);
		expect(e2.valence).toBe(1);
		expect(e2.arousal).toBe(1);
		expect(e2.dominance).toBe(1);
	});

	it("accepts zero values (neutral)", () => {
		const e = createEmotion(0, 0, 0);
		expect(e.valence).toBe(0);
		expect(e.arousal).toBe(0);
		expect(e.dominance).toBe(0);
	});
});

// ─── NEUTRAL_EMOTION ────────────────────────────────────────────

describe("NEUTRAL_EMOTION", () => {
	it("is the origin point (0, 0, 0)", () => {
		expect(NEUTRAL_EMOTION.valence).toBe(0);
		expect(NEUTRAL_EMOTION.arousal).toBe(0);
		expect(NEUTRAL_EMOTION.dominance).toBe(0);
	});

	it("is frozen (immutable)", () => {
		expect(Object.isFrozen(NEUTRAL_EMOTION)).toBe(true);
	});
});

// ─── EmotionSchema ──────────────────────────────────────────────

describe("EmotionSchema", () => {
	it("parses valid input", () => {
		const result = EmotionSchema.parse({ valence: 0.5, arousal: -0.3, dominance: 0.7 });
		expect(result.valence).toBeCloseTo(0.5);
		expect(result.arousal).toBeCloseTo(-0.3);
		expect(result.dominance).toBeCloseTo(0.7);
	});

	it("clamps out-of-range values via transform", () => {
		const result = EmotionSchema.parse({ valence: 2, arousal: -3, dominance: 1.1 });
		expect(result.valence).toBe(1);
		expect(result.arousal).toBe(-1);
		expect(result.dominance).toBe(1);
	});

	it("rejects non-numeric values", () => {
		expect(() => EmotionSchema.parse({ valence: "high", arousal: 0, dominance: 0 })).toThrow();
	});

	it("rejects missing fields", () => {
		expect(() => EmotionSchema.parse({ valence: 0 })).toThrow();
		expect(() => EmotionSchema.parse({})).toThrow();
	});
});

// ─── VrmExpression ──────────────────────────────────────────────

describe("VrmExpressionSchema", () => {
	const validExpressions: VrmExpression[] = [
		"happy",
		"relaxed",
		"angry",
		"sad",
		"surprised",
		"neutral",
		"fear",
	];

	it("accepts all 7 valid expressions", () => {
		for (const expr of validExpressions) {
			expect(VrmExpressionSchema.parse(expr)).toBe(expr);
		}
	});

	it("rejects invalid expression labels", () => {
		expect(() => VrmExpressionSchema.parse("disgust")).toThrow();
		expect(() => VrmExpressionSchema.parse("")).toThrow();
		expect(() => VrmExpressionSchema.parse(42)).toThrow();
	});
});

// ─── VrmExpressionWeight ────────────────────────────────────────

describe("VrmExpressionWeightSchema", () => {
	it("accepts valid expression with weight", () => {
		const result = VrmExpressionWeightSchema.parse({ expression: "happy", weight: 0.8 });
		expect(result.expression).toBe("happy");
		expect(result.weight).toBeCloseTo(0.8);
	});

	it("accepts weight at boundaries (0 and 1)", () => {
		expect(VrmExpressionWeightSchema.parse({ expression: "sad", weight: 0 }).weight).toBe(0);
		expect(VrmExpressionWeightSchema.parse({ expression: "sad", weight: 1 }).weight).toBe(1);
	});

	it("rejects weight outside [0, 1]", () => {
		expect(() => VrmExpressionWeightSchema.parse({ expression: "angry", weight: -0.1 })).toThrow();
		expect(() => VrmExpressionWeightSchema.parse({ expression: "angry", weight: 1.1 })).toThrow();
	});

	it("rejects invalid expression label", () => {
		expect(() => VrmExpressionWeightSchema.parse({ expression: "unknown", weight: 0.5 })).toThrow();
	});
});

// ─── EmotionToExpressionMapper (type contract) ──────────────────

describe("EmotionToExpressionMapper", () => {
	it("defines a mapToExpression method that accepts Emotion and returns VrmExpressionWeight", () => {
		// Type-level contract test: a conforming implementation compiles and runs
		const stubMapper: EmotionToExpressionMapper = {
			mapToExpression(_emotion: Emotion): VrmExpressionWeight {
				return { expression: "neutral", weight: 1.0 };
			},
		};

		const result = stubMapper.mapToExpression(NEUTRAL_EMOTION);
		expect(result.expression).toBe("neutral");
		expect(result.weight).toBe(1.0);
	});
});
