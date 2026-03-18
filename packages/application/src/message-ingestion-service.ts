import type {
	BufferedEvent,
	ConversationMessage,
	ConversationRecorder,
	IncomingMessage,
	Logger,
} from "@vicissitude/shared/types";

export interface BufferedEventStore {
	append(agentId: string, event: BufferedEvent): void;
}

export interface MessageIngestionServiceDeps {
	eventStore: BufferedEventStore;
	logger: Logger;
	recorder?: ConversationRecorder;
}

export interface MessageIngestionOptions {
	recordConversation?: boolean;
	bufferEvent?: boolean;
}

export class MessageIngestionService {
	constructor(private readonly deps: MessageIngestionServiceDeps) {}

	handleIncomingMessage(message: IncomingMessage, options: MessageIngestionOptions = {}): void {
		if (!message.content && message.attachments.length === 0) return;
		if (!message.guildId) {
			this.deps.logger.warn("[message-ingestion] No guildId for message, dropping event");
			return;
		}

		const event: BufferedEvent = {
			ts: message.timestamp.toISOString(),
			authorId: message.authorId,
			authorName: message.authorName,
			messageId: message.messageId,
			content: message.content,
			attachments: message.attachments.length > 0 ? message.attachments : undefined,
			metadata: {
				channelId: message.channelId,
				channelName: message.channelName,
				guildId: message.guildId,
				isBot: message.isBot,
				isMentioned: message.isMentioned,
				isThread: message.isThread,
			},
		};

		if (options.bufferEvent ?? true) {
			const agentId = `discord:${message.guildId}`;
			this.deps.eventStore.append(agentId, event);
			this.deps.logger.info(
				`[message-ingestion] buffered: ch=${message.channelId} author=${message.authorName} mentioned=${message.isMentioned}`,
			);
		}

		if (options.recordConversation) {
			this.recordConversation(message);
		}
	}

	private recordConversation(message: IncomingMessage): void {
		if (!this.deps.recorder || !message.guildId) return;

		const role = message.isBot ? "assistant" : "user";
		let content = message.content;
		if (message.attachments.length > 0) {
			const info = message.attachments.map((a) => `[添付: ${a.filename ?? "unknown"}]`).join(" ");
			content = content ? `${content} ${info}` : info;
		}
		if (!content) return;

		const conversationMessage: ConversationMessage = {
			role,
			content,
			name: message.authorName,
			timestamp: message.timestamp,
		};

		this.deps.recorder.record(message.guildId, conversationMessage).catch((err) => {
			this.deps.logger.error("[message-ingestion] failed to record message", err);
		});
	}
}
