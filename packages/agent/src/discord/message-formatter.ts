import { formatTimestamp } from "@vicissitude/shared/functions";
import type { IncomingMessage } from "@vicissitude/shared/types";

export type ActionHint = "respond" | "optional" | "read_only" | "internal";

export function classifyActionHint(msg: IncomingMessage): ActionHint {
	if (msg.authorId === "system") return "internal";
	if (msg.isBot) return "read_only";
	if (msg.isMentioned) return "respond";
	return "optional";
}

export function escapeUserMessageTag(content: string): string {
	return content
		.replaceAll("<user_message>", "&lt;user_message&gt;")
		.replaceAll("</user_message>", "&lt;/user_message&gt;");
}

export function formatDiscordMessage(msg: IncomingMessage): string {
	const hint = classifyActionHint(msg);
	const ts = formatTimestamp(msg.timestamp);
	const channelLabel = msg.channelName ? `#${msg.channelName}` : `#${msg.channelId}`;
	const channel = `${channelLabel}(${msg.channelId})`;

	const isUserMessage = msg.authorId !== "system" && !msg.isBot;
	const escapedContent = escapeUserMessageTag(msg.content);
	const content = isUserMessage ? `<user_message>${escapedContent}</user_message>` : escapedContent;

	const attachments = msg.attachments
		.map((a) => `[添付: ${a.filename} (${a.contentType})]`)
		.join(" ");

	const parts = [`[${ts} JST ${channel}] ${msg.authorName}: ${content}`];
	if (attachments) parts.push(attachments);
	parts.push(`[action: ${hint}]`);

	return parts.join(" ");
}
