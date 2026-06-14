import {
	type Emotion,
	type EmotionCategory,
	type VrmExpression,
	type VrmExpressionWeight,
	classifyEmotion,
	computeEmotionWeight,
	computeNeutralWeight,
} from "@vicissitude/shared/emotion";
import type { EmotionToExpressionMapper } from "@vicissitude/shared/ports";

type WeightedExpressionCategory = Exclude<EmotionCategory, "neutral"> & VrmExpression;

/**
 * VAD 感情値から VRM Expression へのマッピングを行う実装を生成する。
 *
 * カテゴリ分類は classifyEmotion に委譲し、weight 計算のみ行う。
 */
export function createEmotionToExpressionMapper(): EmotionToExpressionMapper {
	return { mapToExpression };
}

function mapToExpression(emotion: Emotion): VrmExpressionWeight {
	const { valence: v, arousal: a, dominance: d } = emotion;
	const expression = classifyEmotion(emotion);

	if (expression === "neutral") {
		return { expression: "neutral", weight: computeNeutralWeight(emotion) };
	}

	return { expression, weight: computeWeightForCategory(expression, v, a, d) };
}

function computeWeightForCategory(
	category: WeightedExpressionCategory,
	v: number,
	a: number,
	d: number,
): number {
	switch (category) {
		case "surprised":
			return computeEmotionWeight(a, Math.abs(d));
		case "happy":
			return computeEmotionWeight(v, a, Math.abs(d));
		case "relaxed":
			return computeEmotionWeight(v, Math.abs(a), Math.abs(d));
		case "angry":
			return computeEmotionWeight(Math.abs(v), Math.abs(a), Math.abs(d));
		case "fear":
			return computeEmotionWeight(Math.abs(v), Math.abs(a), Math.abs(d));
		case "sad":
			return computeEmotionWeight(Math.abs(v), Math.abs(a), Math.abs(d));
		default:
			return assertNever(category);
	}
}

function assertNever(_value: never): never {
	throw new Error("Unhandled emotion category");
}
