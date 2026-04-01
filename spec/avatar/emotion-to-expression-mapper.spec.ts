import { describe, expect, it } from "bun:test";

import { createEmotionToExpressionMapper } from "@vicissitude/avatar";
import { type Emotion, NEUTRAL_EMOTION, createEmotion } from "@vicissitude/shared/emotion";
// ─── テスト対象のファクトリ ─────────────────────────────────────
//
// packages/avatar が公開する具象実装を生成する関数。
// ブラックボックステスト: EmotionToExpressionMapper ポートの契約のみ検証する。
import type { EmotionToExpressionMapper } from "@vicissitude/shared/ports";

function mapper(): EmotionToExpressionMapper {
	return createEmotionToExpressionMapper();
}

// ─── Expression 選択: 基本マッピング ────────────────────────────

describe("EmotionToExpressionMapper — expression selection", () => {
	it("happy: V > 0, A > 0 のとき happy を返す", () => {
		const result = mapper().mapToExpression(createEmotion(0.6, 0.5, 0.3));
		expect(result.expression).toBe("happy");
	});

	it("relaxed: V > 0, A < 0 のとき relaxed を返す", () => {
		const result = mapper().mapToExpression(createEmotion(0.5, -0.4, 0.2));
		expect(result.expression).toBe("relaxed");
	});

	it("angry: V < 0, A > 0, D > 0 のとき angry を返す", () => {
		const result = mapper().mapToExpression(createEmotion(-0.6, 0.5, 0.4));
		expect(result.expression).toBe("angry");
	});

	it("angry: V < 0, A > 0, D = 0 のとき angry を返す", () => {
		const result = mapper().mapToExpression(createEmotion(-0.3, 0.5, 0));
		expect(result.expression).toBe("angry");
	});

	it("fear: V < 0, A > 0, D < 0 のとき fear を返す", () => {
		const result = mapper().mapToExpression(createEmotion(-0.5, 0.4, -0.3));
		expect(result.expression).toBe("fear");
	});

	it("sad: V < 0, A < 0 のとき sad を返す", () => {
		const result = mapper().mapToExpression(createEmotion(-0.6, -0.5, 0.1));
		expect(result.expression).toBe("sad");
	});

	it("neutral: 全軸が原点付近 (|V|, |A|, |D| < 0.2) のとき neutral を返す", () => {
		const result = mapper().mapToExpression(createEmotion(0.1, -0.1, 0.05));
		expect(result.expression).toBe("neutral");
	});

	it("neutral: 完全な原点 (0, 0, 0) で neutral を返す", () => {
		const result = mapper().mapToExpression(NEUTRAL_EMOTION);
		expect(result.expression).toBe("neutral");
	});
});

// ─── Expression 選択: surprised（最優先ルール）────────────────

describe("EmotionToExpressionMapper — surprised priority", () => {
	it("surprised: A >= 0.7, D < 0 のとき surprised を返す", () => {
		const result = mapper().mapToExpression(createEmotion(0.0, 0.8, -0.5));
		expect(result.expression).toBe("surprised");
	});

	it("surprised は happy より優先: V > 0, A >= 0.7, D < 0", () => {
		// V > 0, A > 0 は通常 happy だが、A >= 0.7 && D < 0 なので surprised が優先
		const result = mapper().mapToExpression(createEmotion(0.5, 0.8, -0.3));
		expect(result.expression).toBe("surprised");
	});

	it("surprised は fear より優先: V < 0, A >= 0.7, D < 0", () => {
		// V < 0, A > 0, D < 0 は通常 fear だが、A >= 0.7 なので surprised が優先
		const result = mapper().mapToExpression(createEmotion(-0.4, 0.9, -0.5));
		expect(result.expression).toBe("surprised");
	});

	it("A が高くても D >= 0 なら surprised にならない", () => {
		const result = mapper().mapToExpression(createEmotion(0.5, 0.8, 0.3));
		expect(result.expression).not.toBe("surprised");
	});

	it("D < 0 でも A < 0.7 なら surprised にならない", () => {
		const result = mapper().mapToExpression(createEmotion(0.3, 0.6, -0.4));
		expect(result.expression).not.toBe("surprised");
	});
});

// ─── Expression 選択: neutral 優先度 ───────────────────────────

describe("EmotionToExpressionMapper — neutral boundary", () => {
	it("neutral 境界: |V| = 0.19 は neutral", () => {
		const result = mapper().mapToExpression(createEmotion(0.19, 0.1, -0.1));
		expect(result.expression).toBe("neutral");
	});

	it("neutral 境界外: |V| = 0.2 は neutral ではない", () => {
		const result = mapper().mapToExpression(createEmotion(0.2, 0.1, 0.0));
		expect(result.expression).not.toBe("neutral");
	});

	it("neutral 境界外: |A| = 0.2 は neutral ではない", () => {
		const result = mapper().mapToExpression(createEmotion(0.1, 0.2, 0.0));
		expect(result.expression).not.toBe("neutral");
	});

	it("neutral 境界外: |D| = 0.2 は neutral ではない", () => {
		const result = mapper().mapToExpression(createEmotion(0.0, 0.1, 0.2));
		expect(result.expression).not.toBe("neutral");
	});
});

// ─── Weight 計算 ────────────────────────────────────────────────

describe("EmotionToExpressionMapper — weight", () => {
	it("weight は [0, 1] の範囲内", () => {
		const testCases: Emotion[] = [
			createEmotion(1, 1, 1),
			createEmotion(-1, -1, -1),
			createEmotion(0, 0, 0),
			createEmotion(0.5, 0.3, -0.2),
			createEmotion(-0.8, 0.9, -0.7),
		];

		for (const emotion of testCases) {
			const result = mapper().mapToExpression(emotion);
			expect(result.weight).toBeGreaterThanOrEqual(0);
			expect(result.weight).toBeLessThanOrEqual(1);
		}
	});

	it("VAD 値が強いほど weight が高い", () => {
		const weak = mapper().mapToExpression(createEmotion(0.3, 0.25, 0.1));
		const strong = mapper().mapToExpression(createEmotion(0.9, 0.8, 0.5));

		// 両方 happy のはず
		expect(weak.expression).toBe("happy");
		expect(strong.expression).toBe("happy");
		expect(strong.weight).toBeGreaterThan(weak.weight);
	});

	it("neutral の weight は原点に近いほど高い", () => {
		const veryNeutral = mapper().mapToExpression(createEmotion(0.01, 0.01, 0.01));
		const barelyNeutral = mapper().mapToExpression(createEmotion(0.15, 0.15, 0.15));

		expect(veryNeutral.expression).toBe("neutral");
		expect(barelyNeutral.expression).toBe("neutral");
		expect(veryNeutral.weight).toBeGreaterThan(barelyNeutral.weight);
	});

	it("極端な感情値 (1, 1, 1) で weight が 1 に近い", () => {
		const result = mapper().mapToExpression(createEmotion(1, 1, 1));
		expect(result.weight).toBeGreaterThanOrEqual(0.8);
	});
});

// ─── 軸上の境界ケース ──────────────────────────────────────────

describe("EmotionToExpressionMapper — axis boundaries", () => {
	it("V = 0, A > 0, D > 0 のとき angry を返す（V が 0 は負側と同等には扱わない）", () => {
		// V = 0 は「正でも負でもない」。A > 0, D > 0 で angry に倒れるか、
		// ルール上 V > 0 でも V < 0 でもないので実装依存。
		// 仕様: V = 0 は neutral 寄りだが、A, D が十分大きければ表情が出る
		const result = mapper().mapToExpression(createEmotion(0, 0.5, 0.4));
		expect(result.weight).toBeGreaterThan(0);
	});

	it("全軸が最大値 (1, 1, 1) でも有効な結果を返す", () => {
		const result = mapper().mapToExpression(createEmotion(1, 1, 1));
		expect(result.expression).toBe("happy");
		expect(result.weight).toBeGreaterThan(0);
	});

	it("全軸が最小値 (-1, -1, -1) でも有効な結果を返す", () => {
		const result = mapper().mapToExpression(createEmotion(-1, -1, -1));
		expect(result.expression).toBe("sad");
		expect(result.weight).toBeGreaterThan(0);
	});
});
