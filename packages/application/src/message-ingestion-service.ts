import { discordGuildNamespace } from "@vicissitude/shared/namespace";
import type {
	ConversationMessage,
	ConversationRecorder,
	IncomingMessage,
	Logger,
} from "@vicissitude/shared/types";

export interface MessageIngestionServiceDeps {
	logger: Logger;
	recorder?: ConversationRecorder;
}

export interface MessageIngestionOptions {
	recordConversation?: boolean;
}

export class MessageIngestionService {
	constructor(private readonly deps: MessageIngestionServiceDeps) {}

	handleIncomingMessage(message: IncomingMessage, options: MessageIngestionOptions = {}): void {
		if (!message.content && message.attachments.length === 0) {
			this.deps.logger.info(
				`[message-ingestion] empty message from ${message.authorName}, dropping`,
			);
			return;
		}
		if (!message.guildId) {
			this.deps.logger.warn("[message-ingestion] No guildId for message, dropping event");
			return;
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
			authorId: message.authorId,
			timestamp: message.timestamp,
		};

		this.deps.recorder
			.record(discordGuildNamespace(message.guildId), conversationMessage)
			.catch((err) => {
				this.deps.logger.error("[message-ingestion] failed to record message", err);
			});
	}
}
