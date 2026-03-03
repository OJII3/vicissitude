import type { EventBuffer } from "../../domain/ports/event-buffer.port.ts";
import type { Logger } from "../../domain/ports/logger.port.ts";
import type { IncomingMessage } from "../../domain/ports/message-gateway.port.ts";

export class BufferEventUseCase {
	constructor(
		private readonly buffer: EventBuffer,
		private readonly logger: Logger,
	) {}

	async execute(msg: IncomingMessage): Promise<void> {
		if (!msg.content && msg.attachments.length === 0) return;

		await this.buffer.append({
			ts: msg.timestamp.toISOString(),
			channelId: msg.channelId,
			guildId: msg.guildId,
			authorId: msg.authorId,
			authorName: msg.authorName,
			messageId: msg.messageId,
			content: msg.content,
			attachments: msg.attachments.length > 0 ? msg.attachments : undefined,
			isMentioned: msg.isMentioned,
			isThread: msg.isThread,
		});

		this.logger.info(
			`[buffer-event] buffered: ch=${msg.channelId} author=${msg.authorName} mentioned=${msg.isMentioned}`,
		);
	}
}
