import { z } from "zod";

import { type EmotionCategory, EmotionCategorySchema } from "./emotion";

// ─── TTS Style ──────────────────────────────────────────────────
//
// TTS 音声合成のスタイルラベル。VAD 感情値からマッピングされる。
// TTS エンジン非依存の抽象ラベルとして定義し、
// アダプター層で各エンジン固有のパラメータに変換する。

export type TtsStyle = EmotionCategory;

export const TtsStyleSchema = EmotionCategorySchema;

// ─── TTS Style Params ───────────────────────────────────────────
//
// TTS 合成に渡すスタイルパラメータ。
// EmotionToTtsStyleMapper が VAD 感情値からこの型を生成する。

/** TTS 合成のスタイルパラメータ */
export interface TtsStyleParams {
	/** 感情スタイルラベル */
	readonly style: TtsStyle;
	/** スタイルの適用強度 [0, 1] */
	readonly styleWeight: number;
	/** 話速倍率 [0.5, 2.0]。デフォルト 1.0 */
	readonly speed: number;
}

export const TtsStyleParamsSchema = z
	.object({
		style: TtsStyleSchema,
		styleWeight: z.number().min(0).max(1),
		speed: z.number().min(0.5).max(2.0),
	})
	.readonly();

// ─── TTS Result ─────────────────────────────────────────────────
//
// TtsSynthesizer の合成結果。音声データを含む。

/** TTS 合成結果 */
export interface TtsResult {
	/** 音声データ (WAV) */
	readonly audio: Uint8Array;
	/** 音声フォーマット */
	readonly format: "wav";
	/** 音声の長さ (秒) */
	readonly durationSec: number;
}

// ─── TTS Synthesis Outcome ──────────────────────────────────────

/** TTS 合成失敗の段階 */
export type TtsSynthesisFailureStage = "audio_query" | "synthesis" | "wav_validation";

/** TTS 合成失敗の明示理由 */
export type TtsSynthesisFailureReason =
	| "audio_query_http_error"
	| "audio_query_invalid_response"
	| "synthesis_http_error"
	| "invalid_audio"
	| "aborted"
	| "network_error"
	| "unexpected_error";

/** TTS 合成成功 */
export interface TtsSynthesisSuccess {
	readonly ok: true;
	readonly result: TtsResult;
}

/** TTS 合成失敗 */
export interface TtsSynthesisFailure {
	readonly ok: false;
	readonly reason: TtsSynthesisFailureReason;
	readonly stage?: TtsSynthesisFailureStage;
	readonly status?: number;
	readonly message?: string;
}

/** TTS 合成の reason 付き結果 */
export type TtsSynthesisOutcome = TtsSynthesisSuccess | TtsSynthesisFailure;

// ─── Factory ────────────────────────────────────────────────────

/** デフォルト速度の TtsStyleParams を生成する */
export function createTtsStyleParams(
	style: TtsStyle,
	styleWeight: number,
	speed = 1.0,
): TtsStyleParams {
	return TtsStyleParamsSchema.parse({ style, styleWeight, speed });
}

/** ニュートラルな TtsStyleParams */
export const NEUTRAL_TTS_STYLE: TtsStyleParams = Object.freeze({
	style: "neutral" as const,
	styleWeight: 0,
	speed: 1.0,
});
