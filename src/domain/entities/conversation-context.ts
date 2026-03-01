export interface ConversationMessage {
	authorName: string;
	content: string;
	timestamp: Date;
}

export interface ConversationContext {
	channelId: string;
	messages: ConversationMessage[];
}
