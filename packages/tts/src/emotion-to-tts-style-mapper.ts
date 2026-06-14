import {
	type Emotion,
	classifyEmotion,
	computeEmotionWeight,
	computeNeutralWeight,
} from "@vicissitude/shared/emotion";
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
	const style = classifyEmotion(emotion);
	const styleWeight = computeStyleWeight(emotion, style);
	const speed = computeSpeed(emotion.arousal);

	return createTtsStyleParams(style, styleWeight, speed);
}

function computeStyleWeight(emotion: Emotion, style: string): number {
	if (style === "neutral") {
		return computeNeutralWeight(emotion);
	}
	const { valence: v, arousal: a, dominance: d } = emotion;
	return computeEmotionWeight(Math.abs(v), Math.abs(a), Math.abs(d));
}

function computeSpeed(arousal: number): number {
	const raw = 1.0 + arousal * 0.3;
	return clamp(raw, 0.5, 2.0);
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}
