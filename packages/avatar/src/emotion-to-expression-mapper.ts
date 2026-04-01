import type { Emotion, VrmExpressionWeight } from "@vicissitude/shared/emotion";
import type { EmotionToExpressionMapper } from "@vicissitude/shared/ports";

/**
 * VAD 感情値から VRM Expression へのマッピングを行う実装を生成する。
 *
 * マッピングルール（優先順位順）:
 * 1. surprised: A >= 0.7 && D < 0
 * 2. neutral:   |V| < 0.2 && |A| < 0.2 && |D| < 0.2
 * 3. happy:     V > 0, A > 0
 * 4. relaxed:   V > 0, A < 0
 * 5. angry:     V < 0, A > 0, D >= 0
 * 6. fear:      V < 0, A > 0, D < 0
 * 7. sad:       V < 0, A < 0
 * fallback:     neutral
 */
export function createEmotionToExpressionMapper(): EmotionToExpressionMapper {
	return { mapToExpression };
}

function mapToExpression(emotion: Emotion): VrmExpressionWeight {
	const { valence: v, arousal: a, dominance: d } = emotion;

	// 1. surprised（最優先）
	if (a >= 0.7 && d < 0) {
		return { expression: "surprised", weight: computeWeight(a, Math.abs(d)) };
	}

	// 2. neutral
	if (Math.abs(v) < 0.2 && Math.abs(a) < 0.2 && Math.abs(d) < 0.2) {
		return mapNeutral(v, a, d);
	}

	// 3-7: 主要ルール
	const primary = mapPrimaryExpression(v, a, d);
	if (primary) return primary;

	// fallback: V=0 等で主要ルールに合致しない境界ケース
	return mapFallback(a, d);
}

function mapNeutral(v: number, a: number, d: number): VrmExpressionWeight {
	const distance = Math.sqrt(v * v + a * a + d * d);
	// neutral 領域の最大距離
	const maxDistance = Math.sqrt(0.2 * 0.2 * 3);
	return { expression: "neutral", weight: clampWeight(1 - distance / maxDistance) };
}

function mapPrimaryExpression(v: number, a: number, d: number): VrmExpressionWeight | null {
	if (v > 0 && a > 0) {
		return { expression: "happy", weight: computeWeight(v, a, Math.abs(d)) };
	}
	if (v > 0 && a < 0) {
		return { expression: "relaxed", weight: computeWeight(v, Math.abs(a), Math.abs(d)) };
	}
	if (v < 0 && a > 0 && d >= 0) {
		return { expression: "angry", weight: computeWeight(Math.abs(v), a, Math.abs(d)) };
	}
	if (v < 0 && a > 0 && d < 0) {
		return { expression: "fear", weight: computeWeight(Math.abs(v), a, Math.abs(d)) };
	}
	if (v < 0 && a < 0) {
		return { expression: "sad", weight: computeWeight(Math.abs(v), Math.abs(a), Math.abs(d)) };
	}
	return null;
}

function mapFallback(a: number, d: number): VrmExpressionWeight {
	if (a > 0 && d > 0) {
		return { expression: "angry", weight: computeWeight(Math.abs(a), Math.abs(d)) };
	}
	if (a > 0 && d < 0) {
		return { expression: "fear", weight: computeWeight(Math.abs(a), Math.abs(d)) };
	}
	if (a > 0) {
		return { expression: "happy", weight: computeWeight(Math.abs(a)) };
	}
	if (a < 0) {
		return { expression: "sad", weight: computeWeight(Math.abs(a), Math.abs(d)) };
	}
	return { expression: "neutral", weight: computeWeight(Math.abs(a), Math.abs(d)) };
}

/** 関連する軸の絶対値の平均を [0, 1] に clamp して weight を算出する */
function computeWeight(...values: number[]): number {
	const sum = values.reduce((acc, val) => acc + val, 0);
	return clampWeight(sum / values.length);
}

function clampWeight(value: number): number {
	return Math.max(0, Math.min(1, value));
}
