import { describe, expect, it } from "bun:test";

import { type Emotion, NEUTRAL_EMOTION, createEmotion } from "@vicissitude/shared/emotion";
import type { EmotionToTtsStyleMapper } from "@vicissitude/shared/ports";
import { TtsStyleParamsSchema } from "@vicissitude/shared/tts";
import { createEmotionToTtsStyleMapper } from "@vicissitude/tts";

// ─── テスト対象のファクトリ ─────────────────────────────────────
//
// packages/tts が公開する具象実装を生成する関数。
// ブラックボックステスト: EmotionToTtsStyleMapper ポートの契約のみ検証する。

function mapper(): EmotionToTtsStyleMapper {
	return createEmotionToTtsStyleMapper();
}

// ─── TtsStyle 選択: 基本マッピング ──────────────────────────────

describe("EmotionToTtsStyleMapper — style selection", () => {
	it("happy: V > 0, A > 0 のとき happy を返す", () => {
		const result = mapper().mapToStyle(createEmotion(0.6, 0.5, 0.3));
		expect(result.style).toBe("happy");
	});

	it("relaxed: V > 0, A < 0 のとき relaxed を返す", () => {
		const result = mapper().mapToStyle(createEmotion(0.5, -0.4, 0.2));
		expect(result.style).toBe("relaxed");
	});

	it("angry: V < 0, A > 0, D > 0 のとき angry を返す", () => {
		const result = mapper().mapToStyle(createEmotion(-0.6, 0.5, 0.4));
		expect(result.style).toBe("angry");
	});

	it("fear: V < 0, A > 0, D < 0 のとき fear を返す", () => {
		const result = mapper().mapToStyle(createEmotion(-0.5, 0.4, -0.3));
		expect(result.style).toBe("fear");
	});

	it("sad: V < 0, A < 0 のとき sad を返す", () => {
		const result = mapper().mapToStyle(createEmotion(-0.6, -0.5, 0.1));
		expect(result.style).toBe("sad");
	});

	it("neutral: 全軸が原点付近 (|V|, |A|, |D| < 0.2) のとき neutral を返す", () => {
		const result = mapper().mapToStyle(createEmotion(0.1, -0.1, 0.05));
		expect(result.style).toBe("neutral");
	});

	it("neutral: 完全な原点 (0, 0, 0) で neutral を返す", () => {
		const result = mapper().mapToStyle(NEUTRAL_EMOTION);
		expect(result.style).toBe("neutral");
	});
});

// ─── TtsStyle 選択: surprised（最優先ルール）────────────────────

describe("EmotionToTtsStyleMapper — surprised priority", () => {
	it("surprised: A >= 0.7, D < 0 のとき surprised を返す", () => {
		const result = mapper().mapToStyle(createEmotion(0.0, 0.8, -0.5));
		expect(result.style).toBe("surprised");
	});

	it("surprised は happy より優先: V > 0, A >= 0.7, D < 0", () => {
		const result = mapper().mapToStyle(createEmotion(0.5, 0.8, -0.3));
		expect(result.style).toBe("surprised");
	});

	it("surprised は fear より優先: V < 0, A >= 0.7, D < 0", () => {
		const result = mapper().mapToStyle(createEmotion(-0.4, 0.9, -0.5));
		expect(result.style).toBe("surprised");
	});

	it("A が高くても D >= 0 なら surprised にならない", () => {
		const result = mapper().mapToStyle(createEmotion(0.5, 0.8, 0.3));
		expect(result.style).not.toBe("surprised");
	});

	it("D < 0 でも A < 0.7 なら surprised にならない", () => {
		const result = mapper().mapToStyle(createEmotion(0.3, 0.6, -0.4));
		expect(result.style).not.toBe("surprised");
	});
});

// ─── TtsStyle 選択: neutral 境界 ────────────────────────────────

describe("EmotionToTtsStyleMapper — neutral boundary", () => {
	it("neutral 境界: |V| = 0.19 は neutral", () => {
		const result = mapper().mapToStyle(createEmotion(0.19, 0.1, -0.1));
		expect(result.style).toBe("neutral");
	});

	it("neutral 境界外: |V| = 0.2 は neutral ではない", () => {
		const result = mapper().mapToStyle(createEmotion(0.2, 0.1, 0.0));
		expect(result.style).not.toBe("neutral");
	});

	it("neutral 境界外: |A| = 0.2 は neutral ではない", () => {
		const result = mapper().mapToStyle(createEmotion(0.1, 0.2, 0.0));
		expect(result.style).not.toBe("neutral");
	});

	it("neutral 境界外: |D| = 0.2 は neutral ではない", () => {
		const result = mapper().mapToStyle(createEmotion(0.0, 0.1, 0.2));
		expect(result.style).not.toBe("neutral");
	});
});

// ─── styleWeight 計算 ───────────────────────────────────────────

describe("EmotionToTtsStyleMapper — styleWeight", () => {
	it("styleWeight は [0, 1] の範囲内", () => {
		const testCases: Emotion[] = [
			createEmotion(1, 1, 1),
			createEmotion(-1, -1, -1),
			createEmotion(0, 0, 0),
			createEmotion(0.5, 0.3, -0.2),
			createEmotion(-0.8, 0.9, -0.7),
		];

		for (const emotion of testCases) {
			const result = mapper().mapToStyle(emotion);
			expect(result.styleWeight).toBeGreaterThanOrEqual(0);
			expect(result.styleWeight).toBeLessThanOrEqual(1);
		}
	});

	it("VAD 値が強いほど styleWeight が高い", () => {
		const weak = mapper().mapToStyle(createEmotion(0.3, 0.25, 0.1));
		const strong = mapper().mapToStyle(createEmotion(0.9, 0.8, 0.5));

		expect(weak.style).toBe("happy");
		expect(strong.style).toBe("happy");
		expect(strong.styleWeight).toBeGreaterThan(weak.styleWeight);
	});

	it("neutral の styleWeight は原点に近いほど高い", () => {
		const veryNeutral = mapper().mapToStyle(createEmotion(0.01, 0.01, 0.01));
		const barelyNeutral = mapper().mapToStyle(createEmotion(0.15, 0.15, 0.15));

		expect(veryNeutral.style).toBe("neutral");
		expect(barelyNeutral.style).toBe("neutral");
		expect(veryNeutral.styleWeight).toBeGreaterThan(barelyNeutral.styleWeight);
	});

	it("極端な感情値 (1, 1, 1) で styleWeight が 1 に近い", () => {
		const result = mapper().mapToStyle(createEmotion(1, 1, 1));
		expect(result.styleWeight).toBeGreaterThanOrEqual(0.8);
	});
});

// ─── speed 計算 ─────────────────────────────────────────────────

describe("EmotionToTtsStyleMapper — speed", () => {
	it("speed は [0.5, 2.0] の範囲内", () => {
		const testCases: Emotion[] = [
			createEmotion(1, 1, 1),
			createEmotion(-1, -1, -1),
			createEmotion(0, 0, 0),
			createEmotion(0.5, 0.3, -0.2),
			createEmotion(-0.8, 0.9, -0.7),
		];

		for (const emotion of testCases) {
			const result = mapper().mapToStyle(emotion);
			expect(result.speed).toBeGreaterThanOrEqual(0.5);
			expect(result.speed).toBeLessThanOrEqual(2.0);
		}
	});

	it("高 arousal で speed がデフォルト (1.0) より速い", () => {
		const result = mapper().mapToStyle(createEmotion(0.6, 0.8, 0.3));
		expect(result.speed).toBeGreaterThan(1.0);
	});

	it("低 arousal で speed がデフォルト (1.0) より遅い", () => {
		const result = mapper().mapToStyle(createEmotion(0.5, -0.7, 0.2));
		expect(result.speed).toBeLessThan(1.0);
	});

	it("neutral (arousal ~ 0) で speed が 1.0 付近", () => {
		const result = mapper().mapToStyle(NEUTRAL_EMOTION);
		expect(result.speed).toBeCloseTo(1.0, 1);
	});
});

// ─── TtsStyleParamsSchema バリデーション ────────────────────────

describe("EmotionToTtsStyleMapper — schema validity", () => {
	it("返り値が TtsStyleParamsSchema で valid", () => {
		const testCases: Emotion[] = [
			createEmotion(0.6, 0.5, 0.3),
			createEmotion(-0.5, 0.4, -0.3),
			createEmotion(0.0, 0.8, -0.5),
			createEmotion(0, 0, 0),
			createEmotion(-1, -1, -1),
			createEmotion(1, 1, 1),
		];

		for (const emotion of testCases) {
			const result = mapper().mapToStyle(emotion);
			expect(() => TtsStyleParamsSchema.parse(result)).not.toThrow();
		}
	});
});

// ─── 軸上の境界ケース ──────────────────────────────────────────

describe("EmotionToTtsStyleMapper — axis boundaries", () => {
	it("全軸が最大値 (1, 1, 1) でも有効な結果を返す", () => {
		const result = mapper().mapToStyle(createEmotion(1, 1, 1));
		expect(result.style).toBe("happy");
		expect(result.styleWeight).toBeGreaterThan(0);
	});

	it("全軸が最小値 (-1, -1, -1) でも有効な結果を返す", () => {
		const result = mapper().mapToStyle(createEmotion(-1, -1, -1));
		expect(result.style).toBe("sad");
		expect(result.styleWeight).toBeGreaterThan(0);
	});
});
