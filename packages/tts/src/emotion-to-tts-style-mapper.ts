import type { Emotion } from "@vicissitude/shared/emotion";
import type { EmotionToTtsStyleMapper } from "@vicissitude/shared/ports";
import { type TtsStyle, type TtsStyleParams, createTtsStyleParams } from "@vicissitude/shared/tts";

/**
 * VAD 感情値から TTS スタイルパラメータへのマッピングを行う実装を生成する。
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
export function createEmotionToTtsStyleMapper(): EmotionToTtsStyleMapper {
	return { mapToStyle };
}

function mapToStyle(emotion: Emotion): TtsStyleParams {
	const { valence: v, arousal: a, dominance: d } = emotion;

	const style = determineStyle(v, a, d);
	const styleWeight = computeStyleWeight(style, v, a, d);
	const speed = computeSpeed(a);

	return createTtsStyleParams(style, styleWeight, speed);
}

function determineStyle(v: number, a: number, d: number): TtsStyle {
	// 1. surprised (highest priority)
	if (a >= 0.7 && d < 0) return "surprised";

	// 2. neutral
	if (Math.abs(v) < 0.2 && Math.abs(a) < 0.2 && Math.abs(d) < 0.2) return "neutral";

	// 3-7: primary rules
	if (v > 0 && a > 0) return "happy";
	if (v > 0 && a < 0) return "relaxed";
	if (v < 0 && a > 0 && d >= 0) return "angry";
	if (v < 0 && a > 0 && d < 0) return "fear";
	if (v < 0 && a < 0) return "sad";

	// fallback for boundary cases (v=0 etc.)
	if (a > 0 && d > 0) return "angry";
	if (a > 0 && d < 0) return "fear";
	if (a > 0) return "happy";
	if (a < 0) return "sad";
	return "neutral";
}

function computeStyleWeight(style: TtsStyle, v: number, a: number, d: number): number {
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
