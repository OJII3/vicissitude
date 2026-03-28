import type { Emotion, VrmExpressionWeight } from "./emotion";
import type { TtsResult, TtsStyleParams } from "./tts";
import type { BodyAnimationPreset, ClientMessage, ServerMessage } from "./ws-protocol";

// ─── EmotionToExpressionMapper ─────────────────────────────────
//
// VAD → VRM Expression マッピングのポート。
// 実装は avatar パッケージ（将来）に置く。

/** VAD → VRM Expression マッピングのポートインターフェース */
export interface EmotionToExpressionMapper {
	mapToExpression(emotion: Emotion): VrmExpressionWeight;
}

// ─── EmotionAnalyzer ────────────────────────────────────────────
//
// Agent パッケージが感情推定結果を返すためのポート。
// LLM の structured output で VAD 値を出力し、テキストと共に返す。

/** 感情推定の入力 */
export interface EmotionAnalysisInput {
	/** 分析対象のテキスト（LLM の応答テキスト） */
	readonly text: string;
	/** 会話コンテキスト（直近の会話履歴など） */
	readonly context?: string;
}

/** 感情推定の結果 */
export interface EmotionAnalysisResult {
	readonly emotion: Emotion;
	readonly confidence: number;
}

/** 感情推定ポート。agent パッケージが実装する */
export interface EmotionAnalyzer {
	analyze(input: EmotionAnalysisInput): Promise<EmotionAnalysisResult>;
}

// ─── MoodStore ─────────────────────────────────────────────────
//
// 感情状態（VAD）の永続化ポート。
// agentId ごとに最新の感情値を保持し、有効期限切れなら NEUTRAL_EMOTION を返す。

/** 感情状態の読み取りポート */
export interface MoodReader {
	/** agentId の最新 mood を取得。有効期限切れまたは未設定なら NEUTRAL_EMOTION を返す */
	getMood(agentId: string): Emotion;
}

/** 感情状態の書き込みポート */
export interface MoodWriter {
	/** agentId の mood を更新する */
	setMood(agentId: string, emotion: Emotion): void;
}

// ─── AvatarController ───────────────────────────────────────────
//
// Avatar パッケージが表情・アニメーション制御を受け付けるポート。
// gateway 経由で WebSocket クライアントへ指示を転送する。

/** アバター制御の指示 */
export interface AvatarCommand {
	/** 適用する表情と強度 */
	readonly expressionWeight: VrmExpressionWeight;
	/** ボディアニメーションのプリセット */
	readonly animation?: BodyAnimationPreset;
	/** アニメーション強度 [0, 1] */
	readonly animationIntensity?: number;
}

/** アバター制御ポート。avatar パッケージが実装する */
export interface AvatarController {
	applyEmotion(emotion: Emotion): Promise<AvatarCommand>;
	playAnimation(preset: BodyAnimationPreset, intensity: number): Promise<void>;
}

// ─── EmotionToTtsStyleMapper ────────────────────────────────────
//
// VAD → TTS スタイルパラメータのマッピングポート。
// EmotionToExpressionMapper と並行して、感情を音声スタイルに変換する。

/** VAD → TTS スタイルパラメータのマッピングポート */
export interface EmotionToTtsStyleMapper {
	mapToStyle(emotion: Emotion): TtsStyleParams;
}

// ─── TtsSynthesizer ─────────────────────────────────────────────
//
// TTS 音声合成のポート。TTS エンジン（AivisSpeech 等）を抽象化する。
// GPU PC オフライン時は null を返す（graceful degradation）。

/** TTS 音声合成ポート */
export interface TtsSynthesizer {
	synthesize(text: string, style: TtsStyleParams): Promise<TtsResult | null>;
	isAvailable(): Promise<boolean>;
}

// ─── GatewayPort ────────────────────────────────────────────────
//
// Gateway パッケージが WebSocket 接続管理を提供するポート。
// サーバーメッセージの送信とクライアントメッセージの受信を抽象化する。

/** WebSocket 接続の識別子 */
export type ConnectionId = string;

/** クライアントメッセージを受信したときのハンドラ */
export type ClientMessageHandler = (connectionId: ConnectionId, message: ClientMessage) => void;

/** WebSocket 接続管理ポート。gateway パッケージが実装する */
export interface GatewayPort {
	send(connectionId: ConnectionId, message: ServerMessage): void;
	broadcast(message: ServerMessage): void;
	onMessage(handler: ClientMessageHandler): void;
	getConnectionCount(): number;
}
