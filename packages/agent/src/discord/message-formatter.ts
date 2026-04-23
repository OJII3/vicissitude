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
			"[bot-interaction-hint: このメッセージはbotからです。会話を自然に終結させることを意識してください。相手の発言を繰り返すだけの応答や、新たな質問で会話を引き延ばすことは避けてください。話題が一段落したら、返答せずに会話を終えても構いません。]",
		);
	}

	return parts.join(" ");
}
