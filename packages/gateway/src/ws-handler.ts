import { createEmotionToExpressionMapper } from "@vicissitude/avatar";
import { ConsoleLogger } from "@vicissitude/observability/logger";
import { createEmotion } from "@vicissitude/shared/emotion";
import type {
	ClientMessageHandler,
	ConnectionId,
	EmotionToTtsStyleMapper,
	GatewayPort,
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

const emotionMapper = createEmotionToExpressionMapper();

function randomVad(): number {
	return Math.random() * 2 - 1;
}

export interface WsConnectionManagerDeps {
	ttsSynthesizer?: TtsSynthesizer;
	ttsStyleMapper?: EmotionToTtsStyleMapper;
	logger?: Logger;
}

export class WsConnectionManager implements GatewayPort {
	private readonly connections = new Map<ConnectionId, WebSocketConnection>();
	private readonly handlers: ClientMessageHandler[] = [];
	private readonly ttsSynthesizer: TtsSynthesizer | undefined;
	private readonly ttsStyleMapper: EmotionToTtsStyleMapper | undefined;
	private readonly logger: Logger;

	constructor(deps?: WsConnectionManagerDeps) {
		this.ttsSynthesizer = deps?.ttsSynthesizer;
		this.ttsStyleMapper = deps?.ttsStyleMapper;
		this.logger = deps?.logger ?? new ConsoleLogger();
	}

	handleOpen(connectionId: string, connection: WebSocketConnection): void {
		this.connections.set(connectionId, connection);
	}

	handleClose(connectionId: string): void {
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
			connection.send(JSON.stringify(errorMsg));
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

		// 3. ダミー応答: chat_input に対してエコー + ランダム emotion を返す
		if (message.type === "chat_input") {
			try {
				const now = new Date().toISOString();
				const chatResponse: ChatResponseMessage = {
					type: "chat_message",
					status: "complete",
					text: message.text,
					messageId: crypto.randomUUID(),
					timestamp: now,
				};
				this.send(connectionId, chatResponse);

				const emotion = createEmotion(randomVad(), randomVad(), randomVad());
				const expressionWeight = emotionMapper.mapToExpression(emotion);
				const emotionUpdate: EmotionUpdateMessage = {
					type: "emotion_update",
					emotion,
					expressionWeight,
					timestamp: now,
				};
				this.broadcast(emotionUpdate);

				// TTS 合成（非同期・fire-and-forget）
				if (this.ttsSynthesizer && this.ttsStyleMapper) {
					const ttsStyle = this.ttsStyleMapper.mapToStyle(emotion);
					void this.synthesizeAndSend({
						connectionId,
						messageId: chatResponse.messageId,
						text: message.text,
						style: ttsStyle,
						synthesizer: this.ttsSynthesizer,
					});
				}
			} catch (error) {
				this.logger.error("[gateway] Dummy response handler failed", {
					connectionId,
					error,
				});
			}
		}
	}

	send(connectionId: ConnectionId, message: ServerMessage): void {
		const connection = this.connections.get(connectionId);
		if (!connection) return;
		connection.send(JSON.stringify(message));
	}

	broadcast(message: ServerMessage): void {
		const data = JSON.stringify(message);
		for (const connection of this.connections.values()) {
			connection.send(data);
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
	}): Promise<void> {
		try {
			const result = await params.synthesizer.synthesize(params.text, params.style);
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
}
