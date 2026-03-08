import type { ConversationRecorder } from "../../domain/ports/conversation-recorder.port.ts";
import type { Logger } from "../../domain/ports/logger.port.ts";
import type { IncomingMessage } from "../../domain/ports/message-gateway.port.ts";

export class RecordConversationUseCase {
	constructor(
		private readonly recorder: ConversationRecorder,
		private readonly logger: Logger,
	) {}

	async execute(msg: IncomingMessage): Promise<void> {
		if (!msg.guildId) return;
		if (!msg.content && msg.attachments.length === 0) return;

		const role = msg.isBot ? "assistant" : "user";
		let content = msg.content;
		if (msg.attachments.length > 0) {
			const info = msg.attachments.map((a) => `[添付: ${a.filename ?? "unknown"}]`).join(" ");
			content = content ? `${content} ${info}` : info;
		}

		await this.recorder.record(msg.guildId, {
			role,
			content,
			name: msg.authorName,
			timestamp: msg.timestamp,
		});

		this.logger.info(`[ltm-record] guild=${msg.guildId} author=${msg.authorName} bot=${msg.isBot}`);
	}
}
