import { describe, expect, it } from "bun:test";

import { createEmotion, describeEmotion } from "@vicissitude/shared/emotion";

// ─── describeEmotion ────────────────────────────────────────────
//
// VAD 感情値を日本語の自然言語記述に変換する純粋関数。
// 基本感情カテゴリ + 強度修飾語で構成される文字列を返す。

describe("describeEmotion", () => {
	// ─── 基本感情カテゴリ ───────────────────────────────────────

	describe("happy (V > 0, A > 0)", () => {
		it("嬉しい系の記述を返す", () => {
			const result = describeEmotion(createEmotion(0.5, 0.5, 0.3));
			expect(result).toContain("嬉しい");
		});
	});

	describe("relaxed (V > 0, A < 0)", () => {
		it("リラックス系の記述を返す", () => {
			const result = describeEmotion(createEmotion(0.5, -0.5, 0.3));
			expect(result).toContain("リラックス");
		});
	});

	describe("angry (V < 0, A > 0, D > 0)", () => {
		it("怒り系の記述を返す", () => {
			const result = describeEmotion(createEmotion(-0.5, 0.5, 0.5));
			expect(result).toContain("怒");
		});
	});

	describe("angry (V < 0, A > 0, D = 0)", () => {
		it("D = 0 でも怒り系の記述を返す", () => {
			const result = describeEmotion(createEmotion(-0.5, 0.5, 0));
			expect(result).toContain("怒");
		});
	});

	describe("sad (V < 0, A < 0)", () => {
		it("悲しい系の記述を返す", () => {
			const result = describeEmotion(createEmotion(-0.5, -0.5, -0.3));
			expect(result).toContain("悲しい");
		});
	});

	describe("surprised (A >= 0.7, D < 0)", () => {
		it("驚き系の記述を返す", () => {
			const result = describeEmotion(createEmotion(0.3, 0.8, -0.5));
			expect(result).toContain("驚");
		});
	});

	describe("fear (V < 0, A > 0, D < 0)", () => {
		it("恐怖系の記述を返す", () => {
			const result = describeEmotion(createEmotion(-0.5, 0.5, -0.5));
			expect(result).toContain("怖");
		});
	});

	describe("neutral (|V| < 0.2, |A| < 0.2, |D| < 0.2)", () => {
		it("平常・穏やか系の記述を返す", () => {
			const result = describeEmotion(createEmotion(0.1, 0.05, -0.1));
			expect(result).toContain("穏やか");
		});
	});

	// ─── 強度修飾語 ─────────────────────────────────────────────
	//
	// VAD ベクトルの大きさ (magnitude) で強度を判定:
	//   小 (< 0.4): 「少し」
	//   中 (0.4-0.7): 修飾語なし
	//   大 (> 0.7): 「とても」

	describe("強度修飾語", () => {
		it("小さい強度 (magnitude < 0.4) では「少し」を含む", () => {
			// V=0.2, A=0.15, D=0.1 → magnitude ≈ 0.27
			const result = describeEmotion(createEmotion(0.2, 0.15, 0.1));
			expect(result).toContain("少し");
		});

		it("中程度の強度 (0.4-0.7) では「少し」「とても」を含まない", () => {
			// V=0.4, A=0.3, D=0.2 → magnitude ≈ 0.54
			const result = describeEmotion(createEmotion(0.4, 0.3, 0.2));
			expect(result).not.toContain("少し");
			expect(result).not.toContain("とても");
		});

		it("大きい強度 (magnitude > 0.7) では「とても」を含む", () => {
			// V=0.8, A=0.6, D=0.5 → magnitude ≈ 1.12
			const result = describeEmotion(createEmotion(0.8, 0.6, 0.5));
			expect(result).toContain("とても");
		});
	});

	// ─── 出力形式 ───────────────────────────────────────────────

	describe("出力形式", () => {
		it("「気分」で終わる文字列を返す", () => {
			const result = describeEmotion(createEmotion(0.5, 0.5, 0.3));
			expect(result).toContain("気分");
		});

		it("文字列型を返す", () => {
			const result = describeEmotion(createEmotion(0, 0, 0));
			expect(typeof result).toBe("string");
		});
	});

	// ─── fallback（主要ルール非該当の境界ケース） ────────────────

	describe("fallback（主要ルール非該当の境界ケース）", () => {
		it("a > 0, d > 0 → 怒り系の記述を返す (angry fallback)", () => {
			const result = describeEmotion(createEmotion(0, 0.5, 0.5));
			expect(result).toContain("怒");
		});

		it("a > 0, d < 0 → 恐怖系の記述を返す (fear fallback)", () => {
			const result = describeEmotion(createEmotion(0, 0.5, -0.5));
			expect(result).toContain("怖");
		});

		it("a > 0, d = 0 → 嬉しい系の記述を返す (happy fallback)", () => {
			const result = describeEmotion(createEmotion(0, 0.5, 0));
			expect(result).toContain("嬉しい");
		});

		it("a < 0, d = 0 → 悲しい系の記述を返す (sad fallback)", () => {
			const result = describeEmotion(createEmotion(0, -0.5, 0));
			expect(result).toContain("悲しい");
		});

		it("a = 0, d > 0 → 穏やか系の記述を返す (neutral fallback)", () => {
			const result = describeEmotion(createEmotion(0, 0, 0.5));
			expect(result).toContain("穏やか");
		});
	});
});
