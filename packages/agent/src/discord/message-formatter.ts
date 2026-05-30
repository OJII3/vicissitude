import { escapeUserMessageTag, formatTimestamp } from "@vicissitude/shared/functions";
import type { Attachment, IncomingMessage } from "@vicissitude/shared/types";

export type ActionHint = "respond" | "optional" | "internal";

export function classifyActionHint(msg: IncomingMessage): ActionHint {
	if (msg.authorId === "system") return "internal";
	if (msg.isBot) return "optional";
	if (msg.isMentioned) return "respond";
	return "optional";
}

export { escapeUserMessageTag };

function formatAttachment(attachment: Attachment): string {
	const base = `[添付: ${attachment.filename} (${attachment.contentType})`;
	if (attachment.contentType?.startsWith("image/")) return `${base}]`;
	return `${base} ${attachment.url}]`;
}

export interface FormatDiscordMessageOptions {
	/**
	 * 信頼ユーザーの authorId 集合。`msg.authorId` がこの集合に含まれるとき、
	 * 出力プロンプトに `[trusted-requester]` マーカーを付与する。
	 * 表示名はなりすまし可能なため、信頼判定は必ず authorId 照合で行う。
	 * 未指定・空集合のときは誰も信頼ユーザーにならない（安全側デグレ）。
	 */
	trustedUserIds?: Iterable<string>;
}

function isTrustedRequester(
	msg: IncomingMessage,
	options: FormatDiscordMessageOptions | undefined,
): boolean {
	if (!options?.trustedUserIds) return false;
	for (const id of options.trustedUserIds) {
		if (id === msg.authorId) return true;
	}
	return false;
}

export function formatDiscordMessage(
	msg: IncomingMessage,
	options?: FormatDiscordMessageOptions,
): string {
	const hint = classifyActionHint(msg);
	const ts = formatTimestamp(msg.timestamp);
	const channel = msg.channelName ? `#${msg.channelName}(${msg.channelId})` : `#${msg.channelId}`;

	const isUserMessage = msg.authorId !== "system" && !msg.isBot;
	const escapedContent = escapeUserMessageTag(msg.content);
	const content = isUserMessage ? `<user_message>${escapedContent}</user_message>` : escapedContent;

	const attachments = msg.attachments.map(formatAttachment).join(" ");

	const parts = [`[${ts} JST ${channel}] ${msg.authorName}: ${content}`];
	if (attachments) parts.push(attachments);
	parts.push(`[action: ${hint}]`);
	if (isTrustedRequester(msg, options)) {
		parts.push("[trusted-requester]");
	}
	if (msg.isBot) {
		parts.push(
			"[bot-interaction-hint: このメッセージはbotによるものです。返事をするかどうかはあなた次第です。同じ話の繰り返しや義務的な相槌は要りません。話が一段落したなら、黙っていても構いません。]",
		);
	}

	return parts.join(" ");
}
