import { agentScopeNamespace, discordScopeId } from "@vicissitude/shared/namespace";
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

export type MessageIngestionResult =
	| { status: "dropped"; reason: "empty_message" | "missing_scope_id" }
	| { status: "accepted"; recorded: boolean }
	| { status: "failed"; reason: "record_failed"; error: unknown };

export class MessageIngestionService {
	constructor(private readonly deps: MessageIngestionServiceDeps) {}

	handleIncomingMessage(
		message: IncomingMessage,
		options: MessageIngestionOptions = {},
	): Promise<MessageIngestionResult> {
		if (!message.content && message.attachments.length === 0) {
			this.deps.logger.info(
				`[message-ingestion] empty message from ${message.authorName}, dropping`,
			);
			return Promise.resolve({ status: "dropped", reason: "empty_message" });
		}
		const scopeId = resolveMessageScopeId(message);
		if (!scopeId) {
			this.deps.logger.warn("[message-ingestion] No scopeId for message, dropping event");
			return Promise.resolve({ status: "dropped", reason: "missing_scope_id" });
		}

		if (options.recordConversation) {
			return this.recordConversation(message, scopeId);
		}

		return Promise.resolve({ status: "accepted", recorded: false });
	}

	private async recordConversation(
		message: IncomingMessage,
		scopeId: string,
	): Promise<MessageIngestionResult> {
		if (!this.deps.recorder) return { status: "accepted", recorded: false };

		const role = message.isBot ? "assistant" : "user";
		let content = message.content;
		if (message.attachments.length > 0) {
			const info = message.attachments.map((a) => `[添付: ${a.filename ?? "unknown"}]`).join(" ");
			content = content ? `${content} ${info}` : info;
		}
		if (!content) return { status: "accepted", recorded: false };

		const conversationMessage: ConversationMessage = {
			role,
			content,
			name: message.authorName,
			authorId: message.authorId,
			timestamp: message.timestamp,
		};

		try {
			await this.deps.recorder.record(agentScopeNamespace(scopeId), conversationMessage);
			return { status: "accepted", recorded: true };
		} catch (err) {
			this.deps.logger.error("[message-ingestion] failed to record message", err);
			return { status: "failed", reason: "record_failed", error: err };
		}
	}
}

function resolveMessageScopeId(message: IncomingMessage): string | null {
	if (message.scopeId) return message.scopeId;
	if (message.guildId) return discordScopeId(message.guildId);
	return null;
}
