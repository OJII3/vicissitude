import {
	type Emotion,
	type VrmExpressionWeight,
	classifyEmotion,
} from "@vicissitude/shared/emotion";
import type { EmotionToExpressionMapper } from "@vicissitude/shared/ports";

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
		return mapNeutral(v, a, d);
	}

	return { expression, weight: computeWeightForCategory(expression, v, a, d) };
}

function mapNeutral(v: number, a: number, d: number): VrmExpressionWeight {
	const distance = Math.sqrt(v * v + a * a + d * d);
	// neutral 領域の最大距離
	const maxDistance = Math.sqrt(0.2 * 0.2 * 3);
	return { expression: "neutral", weight: clampWeight(1 - distance / maxDistance) };
}

function computeWeightForCategory(category: string, v: number, a: number, d: number): number {
	switch (category) {
		case "surprised":
			return computeWeight(a, Math.abs(d));
		case "happy":
			return computeWeight(v, a, Math.abs(d));
		case "relaxed":
			return computeWeight(v, Math.abs(a), Math.abs(d));
		case "angry":
			return computeWeight(Math.abs(v), Math.abs(a), Math.abs(d));
		case "fear":
			return computeWeight(Math.abs(v), Math.abs(a), Math.abs(d));
		case "sad":
			return computeWeight(Math.abs(v), Math.abs(a), Math.abs(d));
		default:
			return computeWeight(Math.abs(a), Math.abs(d));
	}
}

/** 関連する軸の絶対値の平均を [0, 1] に clamp して weight を算出する */
function computeWeight(...values: number[]): number {
	const sum = values.reduce((acc, val) => acc + val, 0);
	return clampWeight(sum / values.length);
}

function clampWeight(value: number): number {
	return Math.max(0, Math.min(1, value));
}
