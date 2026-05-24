import { NEUTRAL_EMOTION } from "@vicissitude/shared/emotion";
import type { Emotion } from "@vicissitude/shared/emotion";
import type {
	ClientMessageHandler,
	ConnectionId,
	EmotionToExpressionMapper,
	EmotionToTtsStyleMapper,
	GatewayPort,
	MoodReader,
	TtsSynthesizer,
} from "@vicissitude/shared/ports";
import type { TtsStyleParams } from "@vicissitude/shared/tts";
import type { Logger } from "@vicissitude/shared/types";
import type {
	AudioDataMessage,
	ChatResponseMessage,
	EmotionUpdateMessage,
	ErrorMessage,
	ServerMessage,
} from "@vicissitude/shared/ws-protocol";
import { parseClientMessage } from "@vicissitude/shared/ws-protocol";

export interface WebSocketConnection {
	send(data: string): void;
}

export interface ChatResponderInput {
	connectionId: ConnectionId;
	text: string;
	timestamp: string;
	signal?: AbortSignal;
}

export interface ChatResponderResult {
	text: string;
	emotion?: Emotion;
}

export interface ChatResponder {
	respond(input: ChatResponderInput): Promise<ChatResponderResult>;
}

export interface WsConnectionManagerDeps {
	emotionToExpressionMapper: EmotionToExpressionMapper;
	chatResponder: ChatResponder;
	ttsSynthesizer?: TtsSynthesizer;
	ttsStyleMapper?: EmotionToTtsStyleMapper;
	moodReader?: MoodReader;
	moodAgentId?: string;
	logger: Logger;
}

export class WsConnectionManager implements GatewayPort {
	private readonly connections = new Map<ConnectionId, WebSocketConnection>();
	private readonly abortControllers = new Map<ConnectionId, AbortController>();
	private readonly handlers: ClientMessageHandler[] = [];
	private readonly ttsSynthesizer: TtsSynthesizer | undefined;
	private readonly ttsStyleMapper: EmotionToTtsStyleMapper | undefined;
	private readonly moodReader: MoodReader | undefined;
	private readonly moodAgentId: string;
	private readonly emotionToExpressionMapper: EmotionToExpressionMapper;
	private readonly chatResponder: ChatResponder;
	private readonly logger: Logger;

	constructor(deps: WsConnectionManagerDeps) {
		this.emotionToExpressionMapper = deps.emotionToExpressionMapper;
		this.chatResponder = deps.chatResponder;
		this.ttsSynthesizer = deps.ttsSynthesizer;
		this.ttsStyleMapper = deps.ttsStyleMapper;
		this.moodReader = deps.moodReader;
		this.moodAgentId = deps.moodAgentId ?? "web:local";
		this.logger = deps.logger;
	}

	handleOpen(connectionId: string, connection: WebSocketConnection): void {
		this.connections.set(connectionId, connection);
		this.abortControllers.set(connectionId, new AbortController());
	}

	handleClose(connectionId: string): void {
		this.abortControllers.get(connectionId)?.abort();
		this.abortControllers.delete(connectionId);
		this.connections.delete(connectionId);
	}

	handleMessage(connectionId: string, rawMessage: string): void {
		const connection = this.connections.get(connectionId);
		if (!connection) return;

		// 1. パース（失敗時は INVALID_MESSAGE を返して早期 return）
		let message: ReturnType<typeof parseClientMessage>;
		try {
			message = parseClientMessage(rawMessage);
		} catch {
			const errorMsg: ErrorMessage = {
				type: "error",
				code: "INVALID_MESSAGE",
				message: "Failed to parse client message",
				timestamp: new Date().toISOString(),
			};
			this.send(connectionId, errorMsg);
			return;
		}

		// 2. ハンドラ呼び出し（ハンドラ単位で try-catch、例外時はログに記録して続行）
		for (const handler of this.handlers) {
			try {
				handler(connectionId, message);
			} catch (error) {
				this.logger.error("[gateway] Message handler threw an exception", {
					connectionId,
					messageType: message.type,
					error,
				});
			}
		}

		if (message.type === "chat_input") {
			const signal = this.abortControllers.get(connectionId)?.signal;
			void this.handleChatInput(connectionId, message, signal);
		}
	}

	send(connectionId: ConnectionId, message: ServerMessage): void {
		const connection = this.connections.get(connectionId);
		if (!connection) return;
		this.sendSerializedMessage(connectionId, connection, JSON.stringify(message));
	}

	broadcast(message: ServerMessage): void {
		const data = JSON.stringify(message);
		for (const [connectionId, connection] of this.connections) {
			this.sendSerializedMessage(connectionId, connection, data);
		}
	}

	onMessage(handler: ClientMessageHandler): void {
		this.handlers.push(handler);
	}

	getConnectionCount(): number {
		return this.connections.size;
	}

	private async synthesizeAndSend(params: {
		connectionId: ConnectionId;
		messageId: string;
		text: string;
		style: TtsStyleParams;
		synthesizer: TtsSynthesizer;
		signal?: AbortSignal;
	}): Promise<void> {
		try {
			const result = await params.synthesizer.synthesize(params.text, params.style, params.signal);
			if (!result) return;

			const audioDataMessage: AudioDataMessage = {
				type: "audio_data",
				messageId: params.messageId,
				audio: Buffer.from(result.audio).toString("base64"),
				format: "wav",
				durationSec: result.durationSec,
				timestamp: new Date().toISOString(),
			};
			this.send(params.connectionId, audioDataMessage);
		} catch (error) {
			this.logger.warn("[gateway] TTS synthesize failed", { error });
		}
	}

	private async handleChatInput(
		connectionId: ConnectionId,
		message: { text: string; timestamp: string },
		signal?: AbortSignal,
	): Promise<void> {
		try {
			const response = await this.chatResponder.respond({
				connectionId,
				text: message.text,
				timestamp: message.timestamp,
				signal,
			});
			if (signal?.aborted) return;

			const now = new Date().toISOString();
			const chatResponse: ChatResponseMessage = {
				type: "chat_message",
				status: "complete",
				text: response.text,
				messageId: crypto.randomUUID(),
				timestamp: now,
			};
			this.send(connectionId, chatResponse);

			const emotion =
				response.emotion ?? this.moodReader?.getMood(this.moodAgentId) ?? NEUTRAL_EMOTION;
			const expressionWeight = this.emotionToExpressionMapper.mapToExpression(emotion);
			const emotionUpdate: EmotionUpdateMessage = {
				type: "emotion_update",
				emotion,
				expressionWeight,
				timestamp: now,
			};
			this.broadcast(emotionUpdate);

			if (this.ttsSynthesizer && this.ttsStyleMapper) {
				const ttsStyle = this.ttsStyleMapper.mapToStyle(emotion);
				void this.synthesizeAndSend({
					connectionId,
					messageId: chatResponse.messageId,
					text: response.text,
					style: ttsStyle,
					synthesizer: this.ttsSynthesizer,
					signal,
				});
			}
		} catch (error) {
			if (signal?.aborted) return;
			this.logger.error("[gateway] Chat response handler failed", {
				connectionId,
				error,
			});
			const errorMsg: ErrorMessage = {
				type: "error",
				code: "CHAT_RESPONSE_FAILED",
				message: "Failed to generate chat response",
				timestamp: new Date().toISOString(),
			};
			this.send(connectionId, errorMsg);
		}
	}

	private sendSerializedMessage(
		connectionId: ConnectionId,
		connection: WebSocketConnection,
		data: string,
	): void {
		try {
			connection.send(data);
		} catch (error) {
			this.logger.error("[gateway] WebSocket send failed", { connectionId, error });
		}
	}
}
