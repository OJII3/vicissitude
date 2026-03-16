import { z } from "zod";

import { EmotionSchema, VrmExpressionWeightSchema } from "./emotion";
import type { Emotion, VrmExpressionWeight } from "./emotion";

// ─── Body Animation Preset ──────────────────────────────────────
//
// VRM ボディアニメーションのプリセット名。
// 感情や状態に応じた定型アニメーションを指定する。

export type BodyAnimationPreset = "idle" | "thinking" | "happy" | "angry" | "sad" | "wave" | "nod";

export const BodyAnimationPresetSchema = z.enum([
	"idle",
	"thinking",
	"happy",
	"angry",
	"sad",
	"wave",
	"nod",
]);

// ─── Server → Client Messages ───────────────────────────────────

/** 感情状態の更新通知 */
export interface EmotionUpdateMessage {
	readonly type: "emotion_update";
	readonly emotion: Emotion;
	readonly expressionWeight: VrmExpressionWeight;
	readonly timestamp: string;
}

/** チャット応答メッセージ（ストリーミング対応） */
export interface ChatMessageMessage {
	readonly type: "chat_message";
	/** "chunk": 増分テキスト, "complete": 最終テキスト */
	readonly status: "chunk" | "complete";
	readonly text: string;
	readonly messageId: string;
	readonly timestamp: string;
}

/** ボディアニメーション指示 */
export interface AnimationCommandMessage {
	readonly type: "animation_command";
	readonly preset: BodyAnimationPreset;
	/** アニメーション適用強度 [0, 1] */
	readonly intensity: number;
	readonly timestamp: string;
}

/** サーバーエラー通知 */
export interface ErrorMessage {
	readonly type: "error";
	readonly code: string;
	readonly message: string;
	readonly timestamp: string;
}

/** サーバー → クライアント メッセージの discriminated union */
export type ServerMessage =
	| EmotionUpdateMessage
	| ChatMessageMessage
	| AnimationCommandMessage
	| ErrorMessage;

// ─── Client → Server Messages ───────────────────────────────────

/** ユーザーのチャット入力 */
export interface ChatInputMessage {
	readonly type: "chat_input";
	readonly text: string;
	readonly timestamp: string;
}

/** クライアント → サーバー メッセージの discriminated union */
export type ClientMessage = ChatInputMessage;

/** 全メッセージの discriminated union */
export type WsMessage = ServerMessage | ClientMessage;

// ─── Message Type Literal ───────────────────────────────────────

export type ServerMessageType = ServerMessage["type"];
export type ClientMessageType = ClientMessage["type"];
export type WsMessageType = WsMessage["type"];

// ─── Zod Schemas ────────────────────────────────────────────────

const isoTimestamp = z.string().datetime();

export const EmotionUpdateMessageSchema = z
	.object({
		type: z.literal("emotion_update"),
		emotion: EmotionSchema,
		expressionWeight: VrmExpressionWeightSchema,
		timestamp: isoTimestamp,
	})
	.readonly();

export const ChatMessageMessageSchema = z
	.object({
		type: z.literal("chat_message"),
		status: z.enum(["chunk", "complete"]),
		text: z.string(),
		messageId: z.string().min(1),
		timestamp: isoTimestamp,
	})
	.readonly();

export const AnimationCommandMessageSchema = z
	.object({
		type: z.literal("animation_command"),
		preset: BodyAnimationPresetSchema,
		intensity: z.number().min(0).max(1),
		timestamp: isoTimestamp,
	})
	.readonly();

export const ErrorMessageSchema = z
	.object({
		type: z.literal("error"),
		code: z.string().min(1),
		message: z.string(),
		timestamp: isoTimestamp,
	})
	.readonly();

export const ServerMessageSchema = z.discriminatedUnion("type", [
	EmotionUpdateMessageSchema,
	ChatMessageMessageSchema,
	AnimationCommandMessageSchema,
	ErrorMessageSchema,
]);

export const ChatInputMessageSchema = z
	.object({
		type: z.literal("chat_input"),
		text: z.string().min(1),
		timestamp: isoTimestamp,
	})
	.readonly();

export const ClientMessageSchema = z.discriminatedUnion("type", [ChatInputMessageSchema]);

export const WsMessageSchema = z.discriminatedUnion("type", [
	EmotionUpdateMessageSchema,
	ChatMessageMessageSchema,
	AnimationCommandMessageSchema,
	ErrorMessageSchema,
	ChatInputMessageSchema,
]);

// ─── Parse Helpers ──────────────────────────────────────────────

/** JSON 文字列をパースしてサーバーメッセージとして検証する */
export function parseServerMessage(raw: string): ServerMessage {
	return ServerMessageSchema.parse(JSON.parse(raw));
}

/** JSON 文字列をパースしてクライアントメッセージとして検証する */
export function parseClientMessage(raw: string): ClientMessage {
	return ClientMessageSchema.parse(JSON.parse(raw));
}
