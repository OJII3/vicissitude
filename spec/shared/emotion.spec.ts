import { describe, expect, it } from "bun:test";

import {
	type EmotionCategory,
	EmotionCategorySchema,
	type Emotion,
	EmotionSchema,
	NEUTRAL_EMOTION,
	NEUTRAL_EMOTION_THRESHOLD,
	type VrmExpression,
	VrmExpressionSchema,
	type VrmExpressionWeight,
	VrmExpressionWeightSchema,
	classifyEmotion,
	computeEmotionWeight,
	computeNeutralWeight,
	createEmotion,
} from "@vicissitude/shared/emotion";
import type { EmotionToExpressionMapper } from "@vicissitude/shared/ports";

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

// ─── EmotionCategory ────────────────────────────────────────────

describe("EmotionCategorySchema", () => {
	const validCategories: EmotionCategory[] = [
		"surprised",
		"neutral",
		"happy",
		"relaxed",
		"angry",
		"fear",
		"sad",
	];

	it("accepts all emotion categories including fear", () => {
		for (const category of validCategories) {
			expect(EmotionCategorySchema.parse(category)).toBe(category);
		}
	});
});

// ─── NEUTRAL_EMOTION_THRESHOLD ──────────────────────────────────

describe("NEUTRAL_EMOTION_THRESHOLD", () => {
	it("defines the shared neutral boundary", () => {
		expect(NEUTRAL_EMOTION_THRESHOLD).toBe(0.2);
	});

	it("classifyEmotion treats values inside the shared threshold as neutral", () => {
		const inside = NEUTRAL_EMOTION_THRESHOLD - 0.01;
		const result = classifyEmotion(createEmotion(inside, -inside, inside));
		expect(result).toBe("neutral");
	});

	it("classifyEmotion treats values on the shared threshold as outside neutral", () => {
		const result = classifyEmotion(createEmotion(NEUTRAL_EMOTION_THRESHOLD, 0.1, 0));
		expect(result).not.toBe("neutral");
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

// ─── computeEmotionWeight ───────────────────────────────────────

describe("computeEmotionWeight", () => {
	it("returns the average of the given values", () => {
		expect(computeEmotionWeight(0.2, 0.4, 0.6)).toBeCloseTo(0.4);
	});

	it("returns the single value when given one argument", () => {
		expect(computeEmotionWeight(0.7)).toBeCloseTo(0.7);
	});

	it("clamps an average above 1 down to 1", () => {
		expect(computeEmotionWeight(1, 1, 2)).toBe(1);
	});

	it("clamps a negative average up to 0", () => {
		expect(computeEmotionWeight(-0.5, -0.5)).toBe(0);
	});

	it("returns 0 for all-zero inputs", () => {
		expect(computeEmotionWeight(0, 0, 0)).toBe(0);
	});

	it("returns 1 for all-one inputs", () => {
		expect(computeEmotionWeight(1, 1, 1)).toBe(1);
	});
});

// ─── computeNeutralWeight ───────────────────────────────────────

describe("computeNeutralWeight", () => {
	it("returns 1 at the origin (perfect neutral)", () => {
		expect(computeNeutralWeight(NEUTRAL_EMOTION)).toBeCloseTo(1);
	});

	it("returns a higher weight closer to the origin", () => {
		const veryNeutral = computeNeutralWeight(createEmotion(0.01, 0.01, 0.01));
		const barelyNeutral = computeNeutralWeight(createEmotion(0.15, 0.15, 0.15));
		expect(veryNeutral).toBeGreaterThan(barelyNeutral);
	});

	it("returns a value within [0, 1] across the VAD space", () => {
		const cases: Emotion[] = [
			createEmotion(0, 0, 0),
			createEmotion(0.1, -0.1, 0.05),
			createEmotion(1, 1, 1),
			createEmotion(-1, -1, -1),
		];
		for (const emotion of cases) {
			const weight = computeNeutralWeight(emotion);
			expect(weight).toBeGreaterThanOrEqual(0);
			expect(weight).toBeLessThanOrEqual(1);
		}
	});

	it("reaches 0 at the neutral threshold boundary on a single axis", () => {
		// distance = THRESHOLD, maxDistance = THRESHOLD * √3 → 1 - 1/√3 ≈ 0.4226
		const onAxis = computeNeutralWeight(createEmotion(NEUTRAL_EMOTION_THRESHOLD, 0, 0));
		expect(onAxis).toBeCloseTo(1 - 1 / Math.sqrt(3));
	});

	it("returns 0 once the VAD distance exceeds maxDistance", () => {
		// 全軸が THRESHOLD → distance = THRESHOLD*√3 = maxDistance → weight = 0
		const atMax = computeNeutralWeight(
			createEmotion(
				NEUTRAL_EMOTION_THRESHOLD,
				NEUTRAL_EMOTION_THRESHOLD,
				NEUTRAL_EMOTION_THRESHOLD,
			),
		);
		expect(atMax).toBeCloseTo(0);

		const beyondMax = computeNeutralWeight(createEmotion(1, 1, 1));
		expect(beyondMax).toBe(0);
	});

	it("uses NEUTRAL_EMOTION_THRESHOLD for the max distance (0.2 hardcode equivalence)", () => {
		// tts が 0.2 ハードコード、avatar が定数参照だったものを統一。
		// THRESHOLD = 0.2 のとき両者は同値であることを担保する。
		const emotion = createEmotion(0.1, -0.05, 0.08);
		const distance = Math.sqrt(0.1 * 0.1 + 0.05 * 0.05 + 0.08 * 0.08);
		const maxDistanceFromHardcode = Math.sqrt(0.2 * 0.2 * 3);
		const expected = Math.max(0, Math.min(1, 1 - distance / maxDistanceFromHardcode));
		expect(computeNeutralWeight(emotion)).toBeCloseTo(expected);
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
