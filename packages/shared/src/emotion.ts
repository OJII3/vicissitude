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

// ─── VRM Expression ─────────────────────────────────────────────
//
// VRM 1.0 標準プリセット + カスタム fear。
// VAD 空間から離散的な表情ラベルへのマッピングに使用する。

export type VrmExpression =
	| "happy"
	| "relaxed"
	| "angry"
	| "sad"
	| "surprised"
	| "neutral"
	| "fear";

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

export const VrmExpressionSchema = z.enum([
	"happy",
	"relaxed",
	"angry",
	"sad",
	"surprised",
	"neutral",
	"fear",
]);

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
