import type { Attachment } from "./attachment.ts";

export interface ConversationMessage {
	authorName: string;
	content: string;
	attachments: Attachment[];
	timestamp: Date;
}

export interface ConversationContext {
	channelId: string;
	messages: ConversationMessage[];
}
