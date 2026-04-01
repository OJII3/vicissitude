import { z } from "zod";

// ─── VAD Emotion Model ──────────────────────────────────────────
//
// 感情を Valence-Arousal-Dominance の 3 次元連続値で表現する。
// 参考: Mehrabian & Russell (1974), PAD emotional state model
//
// - Valence:   快 (+1) ─ 不快 (-1)
// - Arousal:   高覚醒 (+1) ─ 低覚醒 (-1)
// - Dominance: 支配 (+1) ─ 被支配 (-1)
//
// 値域は [-1, 1]。範囲外の値は clamp される。

/** VAD 3 次元感情値。各軸 [-1, 1] */
export interface Emotion {
	readonly valence: number;
	readonly arousal: number;
	readonly dominance: number;
}

// ─── Emotion Category ───────────────────────────────────────────
//
// VAD 空間から分類される離散的な感情カテゴリ。
// VRM Expression・TTS Style など複数のマッパーで共通利用する。

export type EmotionCategory =
	| "surprised"
	| "neutral"
	| "happy"
	| "relaxed"
	| "angry"
	| "fear"
	| "sad";

// ─── VRM Expression ─────────────────────────────────────────────
//
// VRM 1.0 標準プリセット + カスタム fear。
// VAD 空間から離散的な表情ラベルへのマッピングに使用する。

export type VrmExpression = EmotionCategory;

/** VRM Expression と適用強度のペア */
export interface VrmExpressionWeight {
	readonly expression: VrmExpression;
	/** 適用強度 [0, 1] */
	readonly weight: number;
}

// ─── Zod Schemas ────────────────────────────────────────────────

/** [-1, 1] の範囲に clamp する zod スキーマ */
const vadAxis = z.number().transform((v) => Math.max(-1, Math.min(1, v)));

export const EmotionSchema = z
	.object({
		valence: vadAxis,
		arousal: vadAxis,
		dominance: vadAxis,
	})
	.readonly();

export const EmotionCategorySchema = z.enum([
	"surprised",
	"neutral",
	"happy",
	"relaxed",
	"angry",
	"fear",
	"sad",
]);

export const VrmExpressionSchema = EmotionCategorySchema;

export const VrmExpressionWeightSchema = z
	.object({
		expression: VrmExpressionSchema,
		weight: z.number().min(0).max(1),
	})
	.readonly();

// ─── Factory ────────────────────────────────────────────────────

/** 値域を [-1, 1] に clamp して Emotion を生成する */
export function createEmotion(valence: number, arousal: number, dominance: number): Emotion {
	return EmotionSchema.parse({ valence, arousal, dominance });
}

/** 原点 (neutral) の Emotion */
export const NEUTRAL_EMOTION: Emotion = Object.freeze({ valence: 0, arousal: 0, dominance: 0 });

/** Emotion が NEUTRAL_EMOTION と同値かどうか判定する */
export function isNeutralEmotion(emotion: Emotion): boolean {
	return (
		emotion.valence === NEUTRAL_EMOTION.valence &&
		emotion.arousal === NEUTRAL_EMOTION.arousal &&
		emotion.dominance === NEUTRAL_EMOTION.dominance
	);
}

// ─── classifyEmotion ──────────────────────────────────────────
//
// VAD 感情値から離散的な感情カテゴリへ分類する純粋関数。
// 優先順位: surprised → neutral → happy → relaxed → angry → fear → sad → fallback

/** VAD 感情値を離散的な感情カテゴリに分類する */
export function classifyEmotion(emotion: Emotion): EmotionCategory {
	const { valence: v, arousal: a, dominance: d } = emotion;

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

// ─── describeEmotion ───────────────────────────────────────────
//
// VAD 感情値を日本語の自然言語記述に変換する純粋関数。

const categoryLabels: Record<EmotionCategory, string> = {
	surprised: "驚いている",
	neutral: "穏やかな",
	happy: "嬉しい",
	relaxed: "リラックスした",
	angry: "怒っている",
	fear: "怖がっている",
	sad: "悲しい",
};

/** VAD 感情値を日本語の自然言語記述に変換する */
export function describeEmotion(emotion: Emotion): string {
	const { valence: v, arousal: a, dominance: d } = emotion;

	const label = categoryLabels[classifyEmotion(emotion)];

	// 強度修飾語（VADベクトルのユークリッド距離）
	const magnitude = Math.sqrt(v * v + a * a + d * d);
	let modifier: string;
	if (magnitude < 0.4) {
		modifier = "少し";
	} else if (magnitude > 0.7) {
		modifier = "とても";
	} else {
		modifier = "";
	}

	return `${modifier}${label}気分`;
}
