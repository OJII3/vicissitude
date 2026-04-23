import { escapeUserMessageTag, formatTimestamp } from "@vicissitude/shared/functions";
import type { IncomingMessage } from "@vicissitude/shared/types";

export type ActionHint = "respond" | "optional" | "internal";

export function classifyActionHint(msg: IncomingMessage): ActionHint {
	if (msg.authorId === "system") return "internal";
	if (msg.isBot) return "optional";
	if (msg.isMentioned) return "respond";
	return "optional";
}

export { escapeUserMessageTag };

export function formatDiscordMessage(msg: IncomingMessage): string {
	const hint = classifyActionHint(msg);
	const ts = formatTimestamp(msg.timestamp);
	const channel = msg.channelName ? `#${msg.channelName}(${msg.channelId})` : `#${msg.channelId}`;

	const isUserMessage = msg.authorId !== "system" && !msg.isBot;
	const escapedContent = escapeUserMessageTag(msg.content);
	const content = isUserMessage ? `<user_message>${escapedContent}</user_message>` : escapedContent;

	const attachments = msg.attachments
		.map((a) => `[添付: ${a.filename} (${a.contentType}) ${a.url}]`)
		.join(" ");

	const parts = [`[${ts} JST ${channel}] ${msg.authorName}: ${content}`];
	if (attachments) parts.push(attachments);
	parts.push(`[action: ${hint}]`);
	if (msg.isBot) {
		parts.push(
			"[bot-interaction-hint: このメッセージはbotによるものです。返事をするかどうかはあなた次第です。同じ話の繰り返しや義務的な相槌は要りません。話が一段落したなら、黙っていても構いません。]",
		);
	}

	return parts.join(" ");
}
