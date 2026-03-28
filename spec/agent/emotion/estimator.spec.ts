import { describe, expect, it } from "bun:test";

import type { Emotion } from "@vicissitude/shared/emotion";
import { NEUTRAL_EMOTION } from "@vicissitude/shared/emotion";
import type {
	EmotionAnalysisInput,
	EmotionAnalysisResult,
	EmotionAnalyzer,
} from "@vicissitude/shared/ports";

// ─── EmotionAnalyzer ポートの型契約テスト ────────────────────────
//
// EmotionEstimator は LLM を呼ぶため、spec テストでは
// ポート (EmotionAnalyzer) の型契約のみをスタブで検証する。
// 実際の LLM 呼び出しテストは integration テストで行う。

describe("EmotionAnalyzer (型契約)", () => {
	it("analyze メソッドが EmotionAnalysisResult を返す", async () => {
		const stubAnalyzer: EmotionAnalyzer = {
			async analyze(_input: EmotionAnalysisInput): Promise<EmotionAnalysisResult> {
				return {
					emotion: { valence: 0.5, arousal: 0.3, dominance: 0.1 },
					confidence: 0.8,
				};
			},
		};

		const result = await stubAnalyzer.analyze({ text: "楽しい会話だったね！" });

		expect(result.emotion).toBeDefined();
		expect(result.confidence).toBeDefined();
		expect(result.emotion.valence).toBeCloseTo(0.5);
		expect(result.emotion.arousal).toBeCloseTo(0.3);
		expect(result.emotion.dominance).toBeCloseTo(0.1);
		expect(result.confidence).toBeCloseTo(0.8);
	});

	it("結果の Emotion は有効な VAD 値 ([-1, 1]) である", async () => {
		const stubAnalyzer: EmotionAnalyzer = {
			async analyze(): Promise<EmotionAnalysisResult> {
				return {
					emotion: { valence: -0.7, arousal: 0.9, dominance: -0.3 },
					confidence: 0.6,
				};
			},
		};

		const result = await stubAnalyzer.analyze({ text: "test" });
		const { valence, arousal, dominance } = result.emotion;

		expect(valence).toBeGreaterThanOrEqual(-1);
		expect(valence).toBeLessThanOrEqual(1);
		expect(arousal).toBeGreaterThanOrEqual(-1);
		expect(arousal).toBeLessThanOrEqual(1);
		expect(dominance).toBeGreaterThanOrEqual(-1);
		expect(dominance).toBeLessThanOrEqual(1);
	});

	it("結果の confidence は [0, 1] の範囲である", async () => {
		const stubAnalyzer: EmotionAnalyzer = {
			async analyze(): Promise<EmotionAnalysisResult> {
				return {
					emotion: NEUTRAL_EMOTION,
					confidence: 0.95,
				};
			},
		};

		const result = await stubAnalyzer.analyze({ text: "test" });

		expect(result.confidence).toBeGreaterThanOrEqual(0);
		expect(result.confidence).toBeLessThanOrEqual(1);
	});

	it("context が省略可能である", async () => {
		const receivedInputs: EmotionAnalysisInput[] = [];
		const stubAnalyzer: EmotionAnalyzer = {
			async analyze(input: EmotionAnalysisInput): Promise<EmotionAnalysisResult> {
				receivedInputs.push(input);
				return { emotion: NEUTRAL_EMOTION, confidence: 0.5 };
			},
		};

		// context なし
		await stubAnalyzer.analyze({ text: "テスト" });
		// context あり
		await stubAnalyzer.analyze({ text: "テスト", context: "前の会話内容" });

		expect(receivedInputs).toHaveLength(2);
		expect(receivedInputs[0]?.context).toBeUndefined();
		expect(receivedInputs[1]?.context).toBe("前の会話内容");
	});
});
