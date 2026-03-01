export interface ConversationMessage {
	authorName: string;
	content: string;
}

export interface ConversationContext {
	channelId: string;
	messages: ConversationMessage[];
}
