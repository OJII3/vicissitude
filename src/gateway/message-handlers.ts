import type {
	BufferedEvent,
	ConversationMessage,
	ConversationRecorder,
	IncomingMessage,
	Logger,
} from "../core/types.ts";
import type { StoreDb } from "../store/db.ts";
import { appendEvent } from "../store/queries.ts";

// ─── LTM Message Recording ─────────────────────────────────────

export function recordLtmMessage(
	recorder: ConversationRecorder,
	msg: IncomingMessage,
	logger: Logger,
): void {
	if (!msg.guildId) return;
	if (!msg.content && msg.attachments.length === 0) return;

	const role = msg.isBot ? "assistant" : "user";
	let content = msg.content;
	if (msg.attachments.length > 0) {
		const info = msg.attachments.map((a) => `[添付: ${a.filename ?? "unknown"}]`).join(" ");
		content = content ? `${content} ${info}` : info;
	}

	const message: ConversationMessage = {
		role,
		content,
		name: msg.authorName,
		timestamp: msg.timestamp,
	};

	recorder.record(msg.guildId, message).catch((err) => {
		logger.error("[ltm-record] failed to record message", err);
	});
}

// ─── Event Buffering ────────────────────────────────────────────

export function bufferIncomingMessage(db: StoreDb, msg: IncomingMessage, logger: Logger): void {
	if (!msg.content && msg.attachments.length === 0) return;
	if (!msg.guildId) {
		logger.warn(`[bootstrap] No guildId for message, dropping event`);
		return;
	}

	const event: BufferedEvent = {
		ts: msg.timestamp.toISOString(),
		channelId: msg.channelId,
		guildId: msg.guildId,
		authorId: msg.authorId,
		authorName: msg.authorName,
		messageId: msg.messageId,
		content: msg.content,
		attachments: msg.attachments.length > 0 ? msg.attachments : undefined,
		isBot: msg.isBot,
		isMentioned: msg.isMentioned,
		isThread: msg.isThread,
	};

	appendEvent(db, msg.guildId, JSON.stringify(event));
	logger.info(
		`[buffer-event] buffered: ch=${msg.channelId} author=${msg.authorName} mentioned=${msg.isMentioned}`,
	);
}
