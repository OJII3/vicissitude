import { type Emotion, classifyEmotion } from "@vicissitude/shared/emotion";
import type { EmotionToTtsStyleMapper } from "@vicissitude/shared/ports";
import { type TtsStyleParams, createTtsStyleParams } from "@vicissitude/shared/tts";

/**
 * VAD 感情値から TTS スタイルパラメータへのマッピングを行う実装を生成する。
 *
 * カテゴリ分類は classifyEmotion に委譲し、weight・speed 計算のみ行う。
 */
export function createEmotionToTtsStyleMapper(): EmotionToTtsStyleMapper {
	return { mapToStyle };
}

function mapToStyle(emotion: Emotion): TtsStyleParams {
	const { valence: v, arousal: a, dominance: d } = emotion;

	const style = classifyEmotion(emotion);
	const styleWeight = computeStyleWeight(style, v, a, d);
	const speed = computeSpeed(a);

	return createTtsStyleParams(style, styleWeight, speed);
}

function computeStyleWeight(style: string, v: number, a: number, d: number): number {
	if (style === "neutral") {
		const distance = Math.sqrt(v * v + a * a + d * d);
		const maxDistance = Math.sqrt(0.2 * 0.2 * 3);
		return clamp(1 - distance / maxDistance, 0, 1);
	}
	return computeWeight(Math.abs(v), Math.abs(a), Math.abs(d));
}

function computeSpeed(arousal: number): number {
	const raw = 1.0 + arousal * 0.3;
	return clamp(raw, 0.5, 2.0);
}

function computeWeight(...values: number[]): number {
	const sum = values.reduce((acc, val) => acc + val, 0);
	return clamp(sum / values.length, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}
