import { describe, expect, it } from "bun:test";

import { createEmotion } from "@vicissitude/shared/emotion";

import { createEmotionToTtsStyleMapper } from "./emotion-to-tts-style-mapper";

const mapper = createEmotionToTtsStyleMapper();

// ─── determineStyle: fallback 分岐 ──────────────────────────────
//
// spec テストでは基本マッピング (V, A の符号で決まるケース) を検証済み。
// ここでは V=0 や D=0 など境界上の fallback パスを網羅する。

describe("determineStyle — fallback branches", () => {
	it("V=0, A>0, D>0 → angry (fallback: a>0 && d>0)", () => {
		const result = mapper.mapToStyle(createEmotion(0, 0.5, 0.4));
		expect(result.style).toBe("angry");
	});

	it("V=0, A>0, D<0 → fear (fallback: a>0 && d<0)", () => {
		const result = mapper.mapToStyle(createEmotion(0, 0.5, -0.4));
		expect(result.style).toBe("fear");
	});

	it("V=0, A>0, D=0 → happy (fallback: a>0)", () => {
		const result = mapper.mapToStyle(createEmotion(0, 0.5, 0));
		expect(result.style).toBe("happy");
	});

	it("V=0, A<0, D=0 → sad (fallback: a<0)", () => {
		const result = mapper.mapToStyle(createEmotion(0, -0.5, 0));
		expect(result.style).toBe("sad");
	});

	it("V=0, A=0, D=0.5 → neutral (final fallback)", () => {
		// V=0, A=0 だが |D|>=0.2 なので neutral 条件 (|V|<0.2 && |A|<0.2 && |D|<0.2) を満たさない
		// しかし他のどのルールにも当てはまらないので最終 fallback の neutral
		const result = mapper.mapToStyle(createEmotion(0, 0, 0.5));
		expect(result.style).toBe("neutral");
	});

	it("V=0, A=0, D=-0.5 → neutral (final fallback)", () => {
		const result = mapper.mapToStyle(createEmotion(0, 0, -0.5));
		expect(result.style).toBe("neutral");
	});

	it("surprised 境界: A=0.7, D=-0.01 → surprised", () => {
		const result = mapper.mapToStyle(createEmotion(0, 0.7, -0.01));
		expect(result.style).toBe("surprised");
	});

	it("surprised 境界外: A=0.69, D<0 → surprised にならない", () => {
		const result = mapper.mapToStyle(createEmotion(0, 0.69, -0.5));
		expect(result.style).not.toBe("surprised");
	});

	it("surprised 境界外: A=0.7, D=0 → surprised にならない", () => {
		const result = mapper.mapToStyle(createEmotion(0, 0.7, 0));
		expect(result.style).not.toBe("surprised");
	});
});

// ─── computeStyleWeight: neutral パス ────────────────────────────

describe("computeStyleWeight — neutral path", () => {
	it("原点 (0,0,0) で weight = 1 (distance=0 → 1 - 0/max = 1)", () => {
		const result = mapper.mapToStyle(createEmotion(0, 0, 0));
		expect(result.styleWeight).toBeCloseTo(1.0, 5);
	});

	it("neutral 境界ギリギリ (0.19, 0.19, 0.19) で weight > 0", () => {
		const result = mapper.mapToStyle(createEmotion(0.19, 0.19, 0.19));
		expect(result.style).toBe("neutral");
		// distance = sqrt(0.19^2 * 3) ≈ 0.329
		// maxDistance = sqrt(0.2^2 * 3) ≈ 0.346
		// weight = 1 - 0.329/0.346 ≈ 0.05
		expect(result.styleWeight).toBeGreaterThan(0);
		expect(result.styleWeight).toBeLessThan(0.1);
	});

	it("neutral 領域中間 (0.1, 0.1, 0.1) で weight は原点より低い", () => {
		const atOrigin = mapper.mapToStyle(createEmotion(0, 0, 0));
		const atMiddle = mapper.mapToStyle(createEmotion(0.1, 0.1, 0.1));
		expect(atMiddle.style).toBe("neutral");
		expect(atMiddle.styleWeight).toBeLessThan(atOrigin.styleWeight);
	});
});

// ─── computeStyleWeight: non-neutral パス ────────────────────────

describe("computeStyleWeight — non-neutral path", () => {
	it("computeWeight は |V|, |A|, |D| の平均値", () => {
		// happy: V=0.6, A=0.4, D=0.2
		// weight = (0.6 + 0.4 + 0.2) / 3 = 0.4
		const result = mapper.mapToStyle(createEmotion(0.6, 0.4, 0.2));
		expect(result.style).toBe("happy");
		expect(result.styleWeight).toBeCloseTo(0.4, 5);
	});

	it("sad: V=-0.9, A=-0.6, D=-0.3 → weight = (0.9+0.6+0.3)/3 = 0.6", () => {
		const result = mapper.mapToStyle(createEmotion(-0.9, -0.6, -0.3));
		expect(result.style).toBe("sad");
		expect(result.styleWeight).toBeCloseTo(0.6, 5);
	});

	it("全軸最大 (1,1,1) → weight = 1.0", () => {
		const result = mapper.mapToStyle(createEmotion(1, 1, 1));
		expect(result.styleWeight).toBeCloseTo(1.0, 5);
	});

	it("低い値 (0.21, 0.21, 0.0) → weight = (0.21+0.21+0)/3 = 0.14", () => {
		const result = mapper.mapToStyle(createEmotion(0.21, 0.21, 0.0));
		expect(result.style).toBe("happy");
		expect(result.styleWeight).toBeCloseTo(0.14, 2);
	});
});

// ─── computeSpeed ────────────────────────────────────────────────

describe("computeSpeed — exact values", () => {
	it("arousal=0 → speed = 1.0 + 0*0.3 = 1.0", () => {
		const result = mapper.mapToStyle(createEmotion(0, 0, 0));
		expect(result.speed).toBeCloseTo(1.0, 5);
	});

	it("arousal=1 → speed = 1.0 + 1*0.3 = 1.3", () => {
		const result = mapper.mapToStyle(createEmotion(0.5, 1.0, 0.3));
		expect(result.speed).toBeCloseTo(1.3, 5);
	});

	it("arousal=-1 → speed = 1.0 + (-1)*0.3 = 0.7", () => {
		const result = mapper.mapToStyle(createEmotion(-0.5, -1.0, -0.3));
		expect(result.speed).toBeCloseTo(0.7, 5);
	});

	it("arousal=0.5 → speed = 1.0 + 0.5*0.3 = 1.15", () => {
		const result = mapper.mapToStyle(createEmotion(0.5, 0.5, 0.3));
		expect(result.speed).toBeCloseTo(1.15, 5);
	});
});

describe("computeSpeed — clamp behavior", () => {
	it("speed は下限 0.5 以上（arousal が極端に低くても clamp される）", () => {
		// arousal=-1 → raw = 0.7 > 0.5 なので通常は clamp されない
		// しかし createEmotion は [-1,1] に clamp するので arousal は最低 -1
		// raw = 1.0 + (-1)*0.3 = 0.7 → 0.5 以上
		const result = mapper.mapToStyle(createEmotion(0.5, -1, 0.3));
		expect(result.speed).toBeGreaterThanOrEqual(0.5);
	});

	it("speed は上限 2.0 以下（arousal が極端に高くても clamp される）", () => {
		// arousal=1 → raw = 1.3 < 2.0 なので通常は clamp されない
		const result = mapper.mapToStyle(createEmotion(0.5, 1, 0.3));
		expect(result.speed).toBeLessThanOrEqual(2.0);
	});
});

// ─── createTtsStyleParams zod validation ─────────────────────────

describe("createTtsStyleParams — zod validation errors", () => {
	it("styleWeight > 1 のとき ZodError がスローされる", () => {
		// createTtsStyleParams は内部で TtsStyleParamsSchema.parse() を呼ぶ
		const { createTtsStyleParams } = require("@vicissitude/shared/tts");
		expect(() => createTtsStyleParams("happy", 1.5, 1.0)).toThrow();
	});

	it("styleWeight < 0 のとき ZodError がスローされる", () => {
		const { createTtsStyleParams } = require("@vicissitude/shared/tts");
		expect(() => createTtsStyleParams("happy", -0.1, 1.0)).toThrow();
	});

	it("speed > 2.0 のとき ZodError がスローされる", () => {
		const { createTtsStyleParams } = require("@vicissitude/shared/tts");
		expect(() => createTtsStyleParams("happy", 0.5, 2.5)).toThrow();
	});

	it("speed < 0.5 のとき ZodError がスローされる", () => {
		const { createTtsStyleParams } = require("@vicissitude/shared/tts");
		expect(() => createTtsStyleParams("happy", 0.5, 0.3)).toThrow();
	});
});
